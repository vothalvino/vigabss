// =============================================================================
// VigaBSS 5.0 — Install mode: live or test
// =============================================================================
// ONE switch for the whole install: INSTALL_MODE (config.install.mode).
//
//   live — a production install (the DEFAULT; nothing to set). Real money and
//          fiscally valid invoices. Test credentials are refused.
//   test — the developer's demo or maintenance server. Nothing real can
//          happen from it. Live credentials are refused.
//
// Everything that has a "sandbox" and a "real" side follows this switch and
// nothing else. There is no per-organization or per-record choice:
//
//   Payments (Stripe)   live: only sk_live_ keys, only livemode events
//                       test: only sk_test_ keys, only test events
//   Invoices (SAT/CFDI) live: PACs stamp in 'production'
//                       test: PACs stamp in 'sandbox'; the 'simulator' PAC
//                             exists only here; documents are watermarked
//   WhatsApp            nothing: Meta's test number and a real number use
//                       the same kind of credentials, so the switch does not
//                       touch WhatsApp
//   Web interface       a flashing DEV MODE badge beside the version (the
//                       signed-in user carries install_mode, routes/auth.js)
//
// To add another integration with a sandbox: read isTestInstall() here. Do
// not add an "environment" field for a person to choose, and do not add a
// second switch.
// =============================================================================

const config = require('../config');

const INSTALL_MODES = ['live', 'test'];

/** 'test' | 'live'. Anything but an explicit 'test' is live. */
function installMode() {
  return config.install?.mode === 'test' ? 'test' : 'live';
}

function isTestInstall() {
  return installMode() === 'test';
}

/**
 * The provider-side environment name for a mode ('sandbox' | 'production'):
 * what pac_providers.environment, payment_gateways.environment and
 * cfdi_documents.pac_environment hold. Derived, never chosen.
 */
function environmentForMode(mode = installMode()) {
  return mode === 'test' ? 'sandbox' : 'production';
}

/** The fiscal (SAT/PAC) environment this install stamps and cancels in. */
function fiscalEnvironment() {
  return environmentForMode(installMode());
}

/** The mode a Stripe secret (or restricted) key belongs to, or null if it is not one. */
function stripeKeyMode(key) {
  const m = /^(?:sk|rk)_(test|live)_/.exec(String(key ?? '').trim());
  return m ? m[1] : null;
}

module.exports = {
  INSTALL_MODES, installMode, isTestInstall, environmentForMode, fiscalEnvironment, stripeKeyMode,
  // The payment code's name for the same switch.
  installPaymentMode: installMode,
};
