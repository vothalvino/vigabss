// =============================================================================
// Settings → Org Config: how each known key is edited and named
// =============================================================================
// The keys themselves come from the server's settings catalog
// (src/services/settingsCatalog.js); this only matches an input to the legal
// values and gives a translated name to keys an operator would not recognise
// from the raw key. The backend validates regardless.
// =============================================================================

/** Keys with a fixed set of values get a select. */
export const SETTING_ENUM_OPTIONS: Record<string, string[]> = {
  mab_password_mode: ['auth_type_accept', 'cleartext'],
  wireguard_server_enabled: ['false', 'true'],
};

/** Numeric keys get a number input with this minimum and step. */
export const SETTING_NUMBER_INPUTS: Record<string, { min: number; step?: string }> = {
  pppoe_auth_failure_threshold: { min: 1 },
  // The cash a reseller may hold before handing it in, unless its own limit is set.
  reseller_default_credit_limit: { min: 0, step: '0.01' },
};

/** i18n keys of the translated names shown above the raw setting key. */
export const SETTING_LABEL_KEYS: Record<string, string> = {
  reseller_default_credit_limit: 'settingsPage.keyLabels.resellerDefaultCreditLimit',
};
