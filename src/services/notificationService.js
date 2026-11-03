// =============================================================================
// VigaBSS 5.0 — Notification helpers
// =============================================================================
// Email goes through emailTransport.sendEmail, SMS and WhatsApp through
// smsTransport.queueSms. sendNotification, a template sender with no callers
// that read message_templates without an organization predicate, was removed
// (ASY-33).
// =============================================================================

/**
 * HTML-escape a value for interpolation into an HTML email body/subject.
 * Shared across every HTML-email sink in the codebase (see the callers
 * below plus src/views/emailTemplates.js, src/services/notificationHooks.js,
 * paymentReminderService.js, scheduledReportService.js, and
 * campaignService.js's merge-field substitution) — this is the ONE escaping
 * helper for that purpose; do not duplicate it. NOT applied to sms/whatsapp
 * bodies, which are plain text — escaping there would corrupt the message
 * the subscriber actually reads (literal "&amp;"). Mirrors
 * cfdiService.escapeXml's output-encoding pattern for CFDI XML.
 *
 * null/undefined become '' rather than the literal strings "null"/
 * "undefined" (String(val) alone would emit those); numbers and other
 * primitives pass through String()'s normal coercion unaffected.
 */
function escapeHtmlForTemplate(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

module.exports = { escapeHtmlForTemplate };
