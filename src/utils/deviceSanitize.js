// =============================================================================
// VigaBSS 5.0 — Device row sanitizer
// =============================================================================
// Strips the encrypted SNMPv3 auth/priv passphrase columns from a `devices`
// record before it is returned by any endpoint. Both columns hold ciphertext
// at rest — but src/utils/encryption.js's encrypt()/decrypt() are transparent
// no-ops when ENCRYPTION_KEY is unset (dev/test/misconfigured prod), in which
// case they hold PLAINTEXT passphrases. The UI only needs to know whether a
// key is configured, not its value, so a boolean is substituted for each.
// Lives in its own module (rather than only inline in src/routes/devices.js)
// so src/routes/discoveryScans.js's onboard-from-discovery endpoint — which
// creates a Device via the model directly, bypassing devices.js's
// crudController — can reuse the exact same redaction. Mirrors
// src/utils/radiusSanitize.js.
// =============================================================================

const { redactSecretColumns } = require('./secretRedaction');
const { sealSecret } = require('./sealSecrets');

/**
 * Encrypt a plaintext `snmp_community` in a create/update body; a blank one is
 * dropped so an edit keeps the stored community. snmpPoller decrypts it.
 */
function sealSnmpCommunity(req, _res, next) {
  try {
    const value = req.body ? req.body.snmp_community : undefined;
    if (value === '' || value === null) delete req.body.snmp_community;
    else if (typeof value === 'string') req.body.snmp_community = sealSecret(value);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Return a shallow copy of a devices row with the encrypted SNMPv3 columns
 * replaced by `has_snmp_v3_auth_key` / `has_snmp_v3_priv_key` booleans.
 * Non-object inputs (null/undefined) are returned unchanged.
 *
 * @param {object|null|undefined} row
 * @returns {object|null|undefined}
 */
function redactDevice(row) {
  if (!row || typeof row !== 'object') return row;
  // The v1/v2c community is a credential too (NET-10): has_snmp_community.
  const rest = redactSecretColumns(row, ['snmp_community']);
  const hasAuthKey = Boolean(rest.snmp_v3_auth_key_encrypted);
  const hasPrivKey = Boolean(rest.snmp_v3_priv_key_encrypted);
  delete rest.snmp_v3_auth_key_encrypted;
  delete rest.snmp_v3_priv_key_encrypted;
  return { ...rest, has_snmp_v3_auth_key: hasAuthKey, has_snmp_v3_priv_key: hasPrivKey };
}

module.exports = { redactDevice, sealSnmpCommunity };
