// =============================================================================
// VigaBSS 5.0 — Payment mode (test or live)
// =============================================================================
// An install either moves real money or it does not, and that is decided once
// for the whole install by PAYMENT_MODE (config.payments.mode), not per
// gateway by a label somebody picks. A Stripe key says which side it is on
// (sk_test_… / sk_live_…, and restricted rk_test_… / rk_live_…), and every
// Stripe event carries `livemode`, so the app reads the mode from those and
// refuses whatever does not belong on this install:
//
//   test — a demo or maintenance server: a live key or event is refused, so
//          no real card can be charged from it.
//   live — a production install (the default): a test key or event is
//          refused, so it cannot be left collecting nothing.
// =============================================================================

const config = require('../config');

const PAYMENT_MODES = ['live', 'test'];

/** 'test' | 'live'. Anything but an explicit 'test' is live. */
function installPaymentMode() {
  return config.payments?.mode === 'test' ? 'test' : 'live';
}

/** The mode a Stripe secret (or restricted) key belongs to, or null if it is not one. */
function stripeKeyMode(key) {
  const m = /^(?:sk|rk)_(test|live)_/.exec(String(key ?? '').trim());
  return m ? m[1] : null;
}

/** payment_gateways.environment for a mode: the column is derived, never chosen. */
function environmentForMode(mode) {
  return mode === 'test' ? 'sandbox' : 'production';
}

module.exports = { PAYMENT_MODES, installPaymentMode, stripeKeyMode, environmentForMode };
