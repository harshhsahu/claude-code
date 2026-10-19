# wa-claude-bridge

Control a Claude Code cloud session from WhatsApp, through MSG91.

```
WhatsApp ──► MSG91 ──webhook──► relay (public host) ──claude -p --cloud──► Claude cloud session
   ▲                                                                              │
   └──────────── MSG91 send API ◄──── node tools/wa-reply.mjs ◄───────────────────┘
```

The relay needs a public HTTPS URL. It **cannot** run inside a Claude cloud session, which accepts no inbound traffic and is reclaimed when idle.

## 1. MSG91
- A WhatsApp Business number connected in MSG91 (Meta approval required).
- Copy your **authkey** (MSG91 dashboard → Authkey).
- Free-form replies only work within **24h of your last message** to that number. That's a WhatsApp rule. Message it first to open the window.

## 2. Push this repo to GitHub
The cloud session clones it, so it gets `CLAUDE.md` and `tools/wa-reply.mjs`. Copy `tools/` and the `CLAUDE.md` rules into any repo you want to control the same way.

## 3. Cloud environment (claude.ai → Code → environment settings)
- **Network access:** Custom → add `control.msg91.com`, and keep the default list.
- **Network secret / env vars:** `MSG91_AUTHKEY`, `MSG91_INTEGRATED_NUMBER`, `WA_OWNER_NUMBER`. Store the authkey as a network secret, not a plain env var: env vars are visible to anyone who uses the environment.

## 4. Sessions (automatic)
Each number in `ALLOWED_NUMBERS` gets its own Claude session, created by its first message and saved in `relay/sessions.json`.

Creating a session from the relay uses `claude -p --cloud "<message>"`. If that doesn't print a session ID on your CLI version, add a routine with an API trigger and set `ROUTINE_FIRE_URL` / `ROUTINE_TOKEN`; the relay then creates sessions through it. You can also paste an existing session ID for a number in the dashboard.

## 5. Run the relay
On a VPS, Render, Railway or Fly. Or on your own machine with `cloudflared tunnel --url http://localhost:8080`.
```bash
npm i -g @anthropic-ai/claude-code && claude auth login   # session mode only
cp relay/.env.example relay/.env    # fill it in
set -a; . relay/.env; set +a
DEBUG=1 npm run relay
```

## 6. Point MSG91 at it
MSG91 → WhatsApp → Webhook (inbound) → `https://<your-host>/wa/<WEBHOOK_SECRET>`

Send `/ping` from your phone. Then send something real, like "run the test suite and open a PR fixing failures".

On the first real message, check the `DEBUG` log. The payload parser covers both MSG91 webhook formats I could find, but it hasn't been tested against a live account. If it logs `no inbound text found`, adjust `extract()` in `relay/server.js` to match the payload.

## What reaches WhatsApp
Hooks in `.claude/settings.json` run inside each cloud session, but only for turns that came through the relay:
- **Stop:** Claude's final message of every turn is sent to the person who asked.
- **AskUserQuestion:** the question and its options go to WhatsApp, and Claude stops until the answer arrives as the next message.
- **Notification (permission prompt):** tells you the session is waiting on a permission prompt you can only answer in claude.ai. Set the session to **Auto** mode so this rarely happens.

## WhatsApp commands
| Command | Does |
|---|---|
| `/session` | Sends the link to your session |
| `/new` | Your next message starts a fresh session |
| `/ping` | Checks the relay is up |
| `/help` | Lists the commands |

## Local dashboard
While the relay runs, open **http://127.0.0.1:8081**. It shows:
- Status: session link, MSG91 config, allowed numbers, when MSG91 last called the webhook
- A live activity feed: incoming messages, what went to Claude, ignored senders, errors, and the raw payload of any message the parser couldn't read
- A command box that sends to Claude through the same path as WhatsApp, plus a button that sends a test WhatsApp message

It only listens on `127.0.0.1` and refuses requests with any other `Host` header. **Never tunnel port 8081**: anyone who reaches it can send commands to Claude without passing the WhatsApp allowlist.

## Modes
| | `MODE=session` | `MODE=routine` |
|---|---|---|
| Memory between commands | Yes, one ongoing session per number | No, each message starts a fresh session |
| Relay needs | `claude` CLI logged in | Routine API token only (plain HTTPS) |
| Routine prompt must say | – | "Carry out the instruction in the routine-fire-payload block, then reply with tools/wa-reply.mjs" (fire text arrives marked as untrusted otherwise) |

## Security
- Only `ALLOWED_NUMBERS` are obeyed. Anyone else is ignored and logged.
- The webhook path contains `WEBHOOK_SECRET`. Make it long and random.
- Whoever has your phone can run code with your GitHub access. Lock your phone. Use branch protection so nothing reaches `main` without review.
