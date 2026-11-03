// =============================================================================
// VigaBSS 5.0 — Notification helpers
// =============================================================================
// escapeHtmlForTemplate is the one HTML-escaping helper for email bodies.
// ASY-33: the dead senders are gone — notificationService.sendNotification
// (no callers, read message_templates with no organization predicate) and
// the email 'queued' drain (nothing ever wrote a queued email row).
// =============================================================================

const fs = require('fs');
const path = require('path');
const notificationService = require('../src/services/notificationService');
const emailTransport = require('../src/services/emailTransport');

describe('escapeHtmlForTemplate', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(notificationService.escapeHtmlForTemplate("O'Brien <script> & \"x\""))
      .toBe('O&#x27;Brien &lt;script&gt; &amp; &quot;x&quot;');
  });

  test('null and undefined become empty strings; numbers pass through', () => {
    expect(notificationService.escapeHtmlForTemplate(null)).toBe('');
    expect(notificationService.escapeHtmlForTemplate(undefined)).toBe('');
    expect(notificationService.escapeHtmlForTemplate(42)).toBe('42');
  });
});

describe('dead notification paths stay removed (ASY-33)', () => {
  test('notificationService has no sender and emailTransport no queue drain', () => {
    expect(Object.keys(notificationService)).toEqual(['escapeHtmlForTemplate']);
    expect(emailTransport.processQueue).toBeUndefined();
  });

  test('no task handles email_send and nothing writes a queued email row', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'taskRunner.js'), 'utf8');
    expect(runner).not.toMatch(/case 'email_send'/);
    const transport = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'emailTransport.js'), 'utf8');
    expect(transport).not.toMatch(/status = 'queued'|'queued'/);
  });
});
