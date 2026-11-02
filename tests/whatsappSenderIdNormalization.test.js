// =============================================================================
// SUP-03 — a provider sender id is international, never a bare MX number
// =============================================================================
// normalizeE164 prefixes 52 to any 10-digit value without '+', and the webhook
// fed it Meta's raw wa_id: a Danish 4521234567 became +524521234567, colliding
// with a real Mexican binding.

const { normalizeSenderId, normalizeE164 } = require('../src/services/whatsappService');

test.each([
  ['4521234567', '+4521234567'],     // Denmark
  ['4747412345', '+4747412345'],     // Norway
  ['6565612345', '+6565612345'],     // Singapore
  ['3545812345', '+3545812345'],     // Iceland
  ['5215512345678', '+525512345678'], // MX legacy 521 form still converges
  ['525512345678', '+525512345678'],
  ['whatsapp:+5215512345678', '+525512345678'], // Twilio
])('sender %s -> %s', (raw, expected) => {
  expect(normalizeSenderId(raw)).toBe(expected);
});

test('a number typed by a person still defaults to MX', () => {
  expect(normalizeE164('55 1234 5678')).toBe('+525512345678');
});

test('the webhook route normalizes the sender with normalizeSenderId', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/whatsappWebhook.js'), 'utf8');
  expect(src).toMatch(/wa\.normalizeSenderId\(m\.from\)/);
  expect(src).not.toMatch(/wa\.normalizeE164\(m\.from\)/);
});
