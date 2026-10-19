// WhatsApp (MSG91 inbound webhook) -> Claude Code cloud session relay.
// Zero dependencies. Run: node relay/server.js  (env: see relay/.env.example)
//
// MODE=session : forwards each message into ONE long-lived cloud session via
//                `claude -p "<msg>" --cloud $CLAUDE_SESSION_ID` (keeps context).
//                Needs the claude CLI installed here and `claude auth login` done.
// MODE=routine : POSTs each message to a routine's /fire endpoint. Every message
//                starts a fresh session (no memory between commands).
//
// Two listeners:
//   PORT    (0.0.0.0) : the MSG91 webhook only. This is the one you tunnel.
//   UI_PORT (127.0.0.1): local dashboard. Never tunnel or expose it: it can
//                        send commands to Claude without any WhatsApp check.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { sendText } from '../tools/msg91.mjs';

const {
  PORT = '8080',
  UI_PORT = '8081',
  WEBHOOK_SECRET,               // MSG91 webhook URL must be https://host/wa/<WEBHOOK_SECRET>
  ALLOWED_NUMBERS = '',         // comma-separated, digits only, e.g. 919812345678
  MODE = 'session',
  CLAUDE_SESSION_ID,
  ROUTINE_FIRE_URL,
  ROUTINE_TOKEN,
  ROUTINE_BETA = 'experimental-cc-routine-2026-04-01',
  DEBUG,
} = process.env;

if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 16) throw new Error('WEBHOOK_SECRET (16+ chars) is required');
const allowed = new Set(ALLOWED_NUMBERS.split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean));
if (!allowed.size) throw new Error('ALLOWED_NUMBERS is required: anyone else could run commands as you');
if (MODE === 'session' && !CLAUDE_SESSION_ID) throw new Error('CLAUDE_SESSION_ID is required in session mode');
if (MODE === 'routine' && !(ROUTINE_FIRE_URL && ROUTINE_TOKEN)) throw new Error('ROUTINE_FIRE_URL and ROUTINE_TOKEN are required in routine mode');
const owner = [...allowed][0];

const seen = new Map(); // message id -> ts, drops webhook retries
const tryJSON = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; } };

// In-memory activity feed for the dashboard (lost on restart).
const events = [];
const listeners = new Set();
const stats = { received: 0, forwarded: 0, ignored: 0, errors: 0, startedAt: Date.now(), lastWebhookAt: null };
function log(type, data = {}) {
  const e = { ts: Date.now(), type, ...data };
  events.push(e);
  if (events.length > 200) events.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of listeners) res.write(line);
}

// MSG91 has shipped two webhook shapes (legacy and "new"); several fields in the
// new one arrive as stringified JSON. Pull sender + text out of either.
function extract(p) {
  if (Array.isArray(p)) p = p[0] || {};
  const direction = p.direction ?? p.Direction;
  if (direction !== undefined && String(direction) !== '0' && String(direction).toLowerCase() !== 'inbound') return null;

  const from = String(p.customerNumber ?? p.customer_number ?? p.from ?? p.sender ?? p.mobile ?? '').replace(/\D/g, '');
  const id = p.uuid ?? p.messageId ?? p.message_uuid ?? p.requestId ?? p.id;

  let text = p.text ?? p.body;
  for (const key of ['messages', 'content', 'message']) {
    if (text) break;
    let v = tryJSON(p[key]);
    if (Array.isArray(v)) v = v[0];
    v = tryJSON(v);
    if (typeof v === 'string') text = v;
    else if (v && typeof v === 'object') text = v.text?.body ?? v.text ?? v.body ?? v.caption;
  }
  if (typeof text === 'object' && text) text = text.body;
  if (!from || !text) return null;
  return { from, text: String(text).trim(), id };
}

function wrap(from, text) {
  return [
    `[WhatsApp command from +${from}]`,
    text,
    '',
    `When finished, report the result to me on WhatsApp by running: node tools/wa-reply.mjs --to ${from} "<short summary>"`,
    '(pipe long output: <cmd> | node tools/wa-reply.mjs --to ' + from + ')',
  ].join('\n');
}

function toSession(msg) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', msg, '--cloud', CLAUDE_SESSION_ID, '--output-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const r = tryJSON(out.trim());
      if (code === 0 && (r?.ok ?? true)) resolve(r?.url || 'queued');
      else reject(new Error(r?.error || err.trim() || `claude exited ${code}`));
    });
  });
}

async function toRoutine(msg) {
  const res = await fetch(ROUTINE_FIRE_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ROUTINE_TOKEN}`,
      'anthropic-beta': ROUTINE_BETA,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: msg }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`routine fire ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.claude_code_session_url;
}

async function forward(from, text, source) {
  const url = MODE === 'routine' ? await toRoutine(wrap(from, text)) : await toSession(wrap(from, text));
  stats.forwarded++;
  log('forwarded', { from, text, source, url: url && url !== 'queued' ? url : null });
  return url;
}

async function handle({ from, text, id }) {
  if (id) {
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > 1000) seen.delete(seen.keys().next().value);
  }
  stats.received++;
  if (!allowed.has(from)) {
    stats.ignored++;
    log('ignored', { from, text });
    console.warn(`ignored message from non-allowed number ${from}`);
    return;
  }
  log('received', { from, text });

  if (/^\/ping$/i.test(text)) {
    await sendText(from, `pong (relay up, mode=${MODE})`);
    return log('reply', { to: from, text: 'pong' });
  }
  if (/^\/help$/i.test(text)) {
    await sendText(from, 'Send any instruction and it goes to Claude.\n/ping - check relay\n/help - this text');
    return log('reply', { to: from, text: 'help' });
  }

  try {
    const url = await forward(from, text, 'whatsapp');
    await sendText(from, `✓ sent to Claude${url && url !== 'queued' ? `\n${url}` : ''}`);
  } catch (e) {
    stats.errors++;
    log('error', { from, text, error: e.message });
    console.error('forward failed:', e.message);
    await sendText(from, `✗ could not reach Claude: ${e.message.slice(0, 300)}`).catch(() => {});
  }
}

// --- Public webhook listener ---------------------------------------------------
http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method !== 'POST' || req.url.split('?')[0] !== `/wa/${WEBHOOK_SECRET}`) {
      res.statusCode = 404;
      return res.end();
    }
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      // MSG91 drops the webhook after ~5s, so answer first, work after.
      res.end('ok');
      stats.lastWebhookAt = Date.now();
      const payload = tryJSON(raw.trim()) ?? Object.fromEntries(new URLSearchParams(raw));
      if (DEBUG) console.log('webhook payload:', raw);
      const msg = extract(typeof payload === 'object' ? payload : Object.fromEntries(new URLSearchParams(raw)));
      if (!msg) {
        log('unparsed', { raw: raw.slice(0, 2000) });
        if (DEBUG) console.log('no inbound text found in payload');
        return;
      }
      handle(msg).catch((e) => console.error(e));
    });
  })
  .listen(Number(PORT), () => console.log(`relay listening on :${PORT} (mode=${MODE})`));

// --- Local dashboard (127.0.0.1 only) -------------------------------------------
const mask = (n) => (n.length > 4 ? `${'•'.repeat(n.length - 4)}${n.slice(-4)}` : n);

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
  });
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    // Block DNS rebinding and cross-site requests: only our own host may talk to us.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.statusCode = 403; return res.end(); }

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(await readFile(new URL('./ui.html', import.meta.url)));
    }
    if (req.method === 'GET' && path === '/api/state') {
      return send(res, 200, {
        mode: MODE,
        session: MODE === 'session' ? CLAUDE_SESSION_ID : null,
        sessionUrl: MODE === 'session' ? `https://claude.ai/code/${CLAUDE_SESSION_ID}` : null,
        allowed: [...allowed].map(mask),
        msg91: Boolean(process.env.MSG91_AUTHKEY && process.env.MSG91_INTEGRATED_NUMBER),
        businessNumber: process.env.MSG91_INTEGRATED_NUMBER ? mask(process.env.MSG91_INTEGRATED_NUMBER) : null,
        webhookPath: `/wa/${WEBHOOK_SECRET.slice(0, 4)}…`,
        webhookPort: PORT,
        stats,
        events,
      });
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      listeners.add(res);
      return req.on('close', () => listeners.delete(res));
    }
    if (req.method === 'POST' && path.startsWith('/api/')) {
      // A custom header forces a CORS preflight, which we never answer, so other sites can't POST here.
      if (req.headers['x-relay-ui'] !== '1') return send(res, 403, { error: 'missing x-relay-ui header' });
      let body;
      try { body = await readJSON(req); } catch { return send(res, 400, { error: 'bad JSON' }); }
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'text is required' });

      try {
        if (path === '/api/command') {
          const url = await forward(owner, text, 'dashboard');
          return send(res, 200, { ok: true, url });
        }
        if (path === '/api/test-whatsapp') {
          await sendText(owner, text);
          log('reply', { to: owner, text, source: 'dashboard' });
          return send(res, 200, { ok: true });
        }
      } catch (e) {
        stats.errors++;
        log('error', { text, error: e.message, source: 'dashboard' });
        return send(res, 502, { error: e.message });
      }
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(Number(UI_PORT), '127.0.0.1', () => console.log(`dashboard on http://127.0.0.1:${UI_PORT}  (local only, do not tunnel)`));
