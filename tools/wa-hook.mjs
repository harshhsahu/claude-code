#!/usr/bin/env node
// Claude Code hooks that route a WhatsApp-driven session's output to WhatsApp.
// Wired up in .claude/settings.json. Each one does nothing unless the latest
// prompt came through the relay (has a "[WhatsApp command from +N]" header).
//
//   stop      : Stop hook. Sends Claude's final message of the turn.
//   ask       : PreToolUse hook on AskUserQuestion. Sends the question with
//               numbered options, then blocks the tool so Claude ends its turn
//               and waits for the answer to arrive as the next message.
//   notify    : Notification hook. Forwards "Claude needs permission" alerts.
import { sendText } from './msg91.mjs';
import { readTranscript, whatsappNumber, lastAssistantText } from './transcript.mjs';

const mode = process.argv[2];
let input = '';
for await (const c of process.stdin) input += c;
const event = JSON.parse(input || '{}');

const entries = await readTranscript(event.transcript_path);
const to = whatsappNumber(entries);
if (!to) process.exit(0);

async function send(text) {
  try {
    await sendText(to, text);
  } catch (e) {
    // Never break the session over a failed send; surface it in the transcript instead.
    console.error(`wa-hook: WhatsApp send failed: ${e.message}`);
  }
}

if (mode === 'stop') {
  if (event.stop_hook_active) process.exit(0);
  const text = lastAssistantText(entries);
  if (text) await send(text);
  process.exit(0);
}

if (mode === 'ask') {
  const qs = event.tool_input?.questions || [];
  const lines = ['❓ Claude needs your answer:'];
  qs.forEach((q, qi) => {
    lines.push('', qs.length > 1 ? `${qi + 1}. ${q.question}` : q.question);
    (q.options || []).forEach((o, oi) => {
      lines.push(`   ${String.fromCharCode(97 + oi)}) ${o.label}${o.description ? ` – ${o.description}` : ''}`);
    });
    if (q.multiSelect) lines.push('   (you can pick more than one)');
  });
  lines.push('', 'Reply with the letter(s) or your own answer.');
  await send(lines.join('\n'));
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'The owner is on WhatsApp and cannot see this UI. The question was sent to them on WhatsApp. ' +
        'End your turn now without further work; their answer will arrive as the next message.',
    },
  }));
  process.exit(0);
}

if (mode === 'notify') {
  const msg = event.message || 'Claude is waiting for you.';
  await send(`⏸ ${msg}\nThis needs the session UI. To avoid it, set the session to Auto mode.`);
  process.exit(0);
}
