'use strict';
// =============================================================================
// ASY-33 — every outgoing message goes through the message outbox
// =============================================================================
// Producers call messageOutbox (enqueue, queueEmail, sendNow, sendEmailNow)
// or smsTransport.queueSms. Calling a transport directly skips the retries,
// rate limits, consent re-check and the staff view. The exceptions are
// listed with their reason.
// =============================================================================

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIRECT_SEND = /\b(sendEmail|sendSms)\s*\(|portalPushService\s*\.\s*dispatch\s*\(|\.dispatch\s*\(\s*\{\s*clientId/;

const ALLOWED = {
  'services/messageOutbox.js': 'the outbox: its channel adapters call the transports',
  'services/emailTransport.js': 'defines sendEmail',
  'services/smsTransport.js': 'defines sendSms',
  'services/emailSettingsService.js': 'the SMTP settings test send reports the connection result itself',
  'services/trapForwardingService.js': 'SNMP trap forwarding has its own durable, retried delivery queue',
};

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : (p.endsWith('.js') ? [p] : []);
  });
}

function directSenders() {
  return files(SRC)
    .filter((f) => {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      return DIRECT_SEND.test(code);
    })
    .map(f => path.relative(SRC, f).split(path.sep).join('/'));
}

test('only the outbox and the reviewed exceptions call a transport directly', () => {
  expect(directSenders().filter(f => !ALLOWED[f])).toEqual([]);
});

test('every exception still sends directly', () => {
  const senders = new Set(directSenders());
  expect(Object.keys(ALLOWED).filter(f => !senders.has(f))).toEqual([]);
});
