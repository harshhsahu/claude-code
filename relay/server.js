// WhatsApp (MSG91 inbound webhook) -> Claude Code cloud session relay.
// Zero dependencies. Run: node relay/server.js  (env: see relay/.env.example)
//
// MODE=session : forwards each message into ONE long-lived cloud session via
//                `claude -p "<msg>" --cloud $CLAUDE_SESSION_ID` (keeps context).
//                Needs the claude CLI installed here and `claude auth login` done.
// MODE=routine : POSTs each message to a routine's /fire endpoint. Every message
//                starts a fresh session (no memory between commands).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { sendText } from '../tools/msg91.mjs';

const {
  PORT = '8080',
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

const seen = new Map(); // message id -> ts, drops webhook retries
const tryJSON = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return s; } };

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

async function handle({ from, text, id }) {
  if (id) {
    if (seen.has(id)) return;
    seen.set(id, Date.now());
    if (seen.size > 1000) seen.delete(seen.keys().next().value);
  }
  if (!allowed.has(from)) { console.warn(`ignored message from non-allowed number ${from}`); return; }

  if (/^\/ping$/i.test(text)) return sendText(from, `pong (relay up, mode=${MODE})`);
  if (/^\/help$/i.test(text)) {
    return sendText(from, 'Send any instruction and it goes to Claude.\n/ping - check relay\n/help - this text');
  }

  try {
    const url = MODE === 'routine' ? await toRoutine(wrap(from, text)) : await toSession(wrap(from, text));
    await sendText(from, `✓ sent to Claude${url && url !== 'queued' ? `\n${url}` : ''}`);
  } catch (e) {
    console.error('forward failed:', e.message);
    await sendText(from, `✗ could not reach Claude: ${e.message.slice(0, 300)}`).catch(() => {});
  }
}

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
      const payload = tryJSON(raw.trim()) ?? Object.fromEntries(new URLSearchParams(raw));
      if (DEBUG) console.log('webhook payload:', raw);
      const msg = extract(typeof payload === 'object' ? payload : Object.fromEntries(new URLSearchParams(raw)));
      if (!msg) { if (DEBUG) console.log('no inbound text found in payload'); return; }
      handle(msg).catch((e) => console.error(e));
    });
  })
  .listen(Number(PORT), () => console.log(`relay listening on :${PORT} (mode=${MODE})`));
