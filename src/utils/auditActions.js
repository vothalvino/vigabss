// =============================================================================
// VigaBSS 5.0 — Audit action catalog (migration 013 era)
// =============================================================================
// audit_logs.action is a free VARCHAR: each feature writes its own verb
// (create, cash_bag_seal, cfdi_stamped, login_failed, ...). The audit page
// used to offer only seven fixed values (create/update/delete/login/logout/
// export/other), so most real actions could not be picked in the filter and
// showed as an unknown grey badge. This module puts every action in a
// category for the filter and the badge colour. The page reads the actions
// that actually occur (GET /audit-logs/actions), so a new verb appears in the
// filter on its own; adding it here only gives it a better category.
//
// Labels are the frontend's job (i18n auditActions.labels.<action>, with a
// readable fallback built from the action itself).
// =============================================================================

const CATEGORIES = Object.freeze([
  'records', 'sign_in', 'security', 'billing', 'resellers', 'cash_bags',
  'service', 'network', 'compliance', 'data', 'other',
]);

// Exact actions first.
const EXACT = Object.freeze({
  // Generic record changes (crudController and most routes).
  create: 'records',
  update: 'records',
  partial_update: 'records',
  delete: 'records',
  soft_delete: 'records',
  restore: 'records',
  merge: 'records',
  convert: 'records',
  close: 'records',

  // Sign-in (services/loginSecurityService.js).
  login: 'sign_in',
  logout: 'sign_in',
  login_success: 'sign_in',
  login_failed: 'sign_in',
  login_mfa_failed: 'sign_in',
  account_locked: 'sign_in',
  portal_login_success: 'sign_in',
  portal_login_failed: 'sign_in',
  portal_account_locked: 'sign_in',

  // Security administration.
  login_ip_auto_blocked: 'security',
  login_ip_blocked: 'security',
  login_ip_unblocked: 'security',
  update_permissions: 'security',
  revoke: 'security',
  deny: 'security',
  csd_uploaded: 'security',
  csd_activated: 'security',

  // Billing and SAT.
  void: 'billing',
  stamp_request: 'billing',
  cancel_cfdi: 'billing',
  client_credit_apply: 'billing',
  tax_report_export: 'billing',

  // Contracts, activation, field work.
  activate: 'service',
  suspended: 'service',
  terminate: 'service',
  renew: 'service',
  renew_activation_reset: 'service',
  cancel_activation: 'service',
  regenerate_pppoe: 'service',
  sign: 'service',
  sign_remote: 'service',
  commissioning_test_record: 'service',
  escalate: 'service',

  // Network.
  disconnect: 'network',
  reboot: 'network',
  configure: 'network',
  noop: 'network',

  // Regulatory compliance and data handling.
  approve_processing: 'compliance',
  approve_release_recovery: 'compliance',
  fulfill: 'compliance',
  reject: 'compliance',
  legal_hold: 'compliance',
  release: 'compliance',
  release_legal_hold: 'compliance',
  release_evidence_hold: 'compliance',
  ingest: 'compliance',

  export: 'data',
  download: 'data',
  test: 'other',
  other: 'other',
});

// Then prefixes, longest first.
const PREFIXES = Object.freeze([
  ['portal_login', 'sign_in'],
  ['login_ip_', 'security'],
  ['login', 'sign_in'],
  ['cash_bag_', 'cash_bags'],
  ['reseller_', 'resellers'],
  ['carrier_', 'cash_bags'],
  ['collector_', 'resellers'],
  ['cfdi_', 'billing'],
  ['rep_', 'billing'],
  ['invoice_', 'billing'],
  ['payment_', 'billing'],
  ['credit_note', 'billing'],
  ['activation_', 'service'],
  ['signing_link_', 'service'],
  ['test_window_', 'service'],
  ['transition:', 'service'],
  ['whatsapp_', 'service'],
  ['radius_', 'network'],
  ['device_', 'network'],
  ['dsar_', 'compliance'],
  ['legal_', 'compliance'],
  ['api_token', 'security'],
  ['password_', 'security'],
  ['mfa_', 'security'],
  ['2fa_', 'security'],
  ['sso_', 'security'],
  ['export_', 'data'],
  ['backup_', 'data'],
]);

/** The category of an audit action ('other' when nothing matches). */
function categoryOf(action) {
  const a = String(action || '').trim().toLowerCase();
  if (!a) return 'other';
  if (Object.prototype.hasOwnProperty.call(EXACT, a)) return EXACT[a];
  for (const [prefix, category] of PREFIXES) {
    if (a.startsWith(prefix)) return category;
  }
  if (a.endsWith('_export')) return 'data';
  return 'other';
}

module.exports = { CATEGORIES, categoryOf, _EXACT: EXACT, _PREFIXES: PREFIXES };
