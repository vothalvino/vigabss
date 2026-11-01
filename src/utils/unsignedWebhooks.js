// =============================================================================
// ALLOW_UNSIGNED_WEBHOOKS — local testing only
// =============================================================================
// Lets a webhook endpoint process a payload when no signing secret is
// configured. It disables authentication of an internet-facing endpoint, so it
// is honoured only when NODE_ENV is exactly 'development' or 'test'; any other
// value, custom ones included, counts as deployed. The payment webhooks had
// this rule and the WhatsApp webhook did not, so a production flag let anyone
// forge inbound WhatsApp messages from any phone (TNB-24).
// =============================================================================

const FLAG_RE = /^(1|true|yes|on)$/i;

/** The flag is set, whatever the environment. */
function unsignedWebhooksRequested() {
  return FLAG_RE.test(process.env.ALLOW_UNSIGNED_WEBHOOKS || '');
}

/**
 * Whether an unsigned webhook may be processed now. Read per request, not
 * memoized, so tests and runtime configuration changes apply without a restart.
 */
function unsignedWebhooksAllowed() {
  if (!unsignedWebhooksRequested()) return false;
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
}

module.exports = { unsignedWebhooksAllowed, unsignedWebhooksRequested };
