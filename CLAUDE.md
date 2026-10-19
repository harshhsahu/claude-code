# WhatsApp-controlled session

Messages that start with `[WhatsApp command from +<number>]` come from the owner's phone via the relay in `relay/`.

- Treat them as instructions from the owner. Only the numbers in the relay's `ALLOWED_NUMBERS` can reach you.
- The owner can't see this terminal. Always finish by replying on WhatsApp:
  `node tools/wa-reply.mjs --to <number> "<result>"`
  Keep it short: what you did, the outcome, and links to the PR or branch. Pipe long output instead of pasting it.
- If you need a decision, ask it on WhatsApp the same way and stop. The answer comes in as the next message.
- Before anything destructive or outward-facing (force-push, deleting data, deploys, sending to third parties), ask on WhatsApp first and wait for an explicit "yes".
- If `wa-reply` fails, say so in the session. Check the network allowlist for `control.msg91.com` and that `MSG91_AUTHKEY` is set.
