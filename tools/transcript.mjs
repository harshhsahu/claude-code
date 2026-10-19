// Helpers for hooks: read a Claude Code transcript (JSONL) and work out which
// WhatsApp number the current turn came from and what Claude last said.
import { readFile } from 'node:fs/promises';

const HEADER = /\[WhatsApp command from \+(\d{6,15})\]/g;

export async function readTranscript(path) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
      : '';

// A "real" user message carries text; tool results are also logged as user entries.
const isPrompt = (e) =>
  e.type === 'user' &&
  !(Array.isArray(e.message?.content) && e.message.content.some((b) => b?.type === 'tool_result')) &&
  textOf(e.message?.content).trim() !== '';

// Number from the most recent prompt that came through the relay, or null.
export function whatsappNumber(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isPrompt(entries[i])) continue;
    const matches = [...textOf(entries[i].message.content).matchAll(HEADER)];
    if (matches.length) return matches.at(-1)[1];
  }
  return null;
}

// Last thing Claude said in text since the latest prompt.
export function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isPrompt(e)) return '';
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content).trim();
      if (t) return t;
    }
  }
  return '';
}
