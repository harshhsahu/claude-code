// Minimal MSG91 WhatsApp client. No dependencies (Node 18+ global fetch).
// Sends free-form "session" text, which WhatsApp only allows within 24h of
// the user's last inbound message. Outside that window you need a template.

const ENDPOINT =
  process.env.MSG91_ENDPOINT ||
  'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/';

const MAX_CHUNK = 4000; // WhatsApp text limit is 4096

export function chunk(text, size = MAX_CHUNK) {
  const parts = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendText(to, text) {
  const authkey = process.env.MSG91_AUTHKEY;
  const from = process.env.MSG91_INTEGRATED_NUMBER;
  if (!authkey || !from) throw new Error('MSG91_AUTHKEY and MSG91_INTEGRATED_NUMBER must be set');

  const recipient = String(to).replace(/\D/g, '');
  for (const part of chunk(text)) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authkey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        integrated_number: from,
        recipient_number: recipient,
        content_type: 'text',
        text: part,
      }),
    });
    const body = await res.text();
    if (!res.ok || /"(type|status)"\s*:\s*"(error|fail)/i.test(body)) {
      throw new Error(`MSG91 send failed (${res.status}): ${body.slice(0, 500)}`);
    }
  }
}
