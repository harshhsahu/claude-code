#!/usr/bin/env node
// Used by Claude inside the cloud session to answer on WhatsApp.
//   node tools/wa-reply.mjs "message"            -> to WA_OWNER_NUMBER
//   node tools/wa-reply.mjs --to 9198xxxx "msg"
//   echo "long output" | node tools/wa-reply.mjs
import { sendText } from './msg91.mjs';

const args = process.argv.slice(2);
let to = process.env.WA_OWNER_NUMBER;
const i = args.indexOf('--to');
if (i !== -1) { to = args[i + 1]; args.splice(i, 2); }

let text = args.join(' ');
if (!text && !process.stdin.isTTY) {
  for await (const c of process.stdin) text += c;
}
if (!to) { console.error('No recipient: set WA_OWNER_NUMBER or pass --to'); process.exit(2); }
if (!text.trim()) { console.error('Nothing to send'); process.exit(2); }

try {
  await sendText(to, text.trim());
  console.log(`sent to ${to}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
