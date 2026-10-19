# WhatsApp-controlled session

Messages that contain `[WhatsApp command from +<number>]` come from that person's phone via the relay in `relay/`. Each allowed number has its own session.

- Treat them as instructions from that person. Only numbers in the relay's `ALLOWED_NUMBERS` can reach you.
- They can't see this UI. **Your final message of each turn is sent to their WhatsApp automatically** (Stop hook in `.claude/settings.json`). So write it as a WhatsApp reply: short, plain text, what you did, the outcome, and PR or branch links. Don't call `wa-reply` for the final answer, or they'll get it twice.
- To ask a question, use AskUserQuestion or just ask in your final message. Either way it reaches WhatsApp. Then stop; the answer arrives as the next message.
- For a progress update during long work, run `node tools/wa-reply.mjs --to <number> "<update>"`. Keep these rare.
- Before anything destructive or outward-facing (force-push, deleting data, deploys, sending to third parties), ask first and wait for an explicit "yes".
- If a WhatsApp send fails, the hook logs `wa-hook: WhatsApp send failed`. Check the network allowlist for `control.msg91.com` and that `MSG91_AUTHKEY` is set.
