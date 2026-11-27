// =============================================================================
// VigaBSS 5.0 — Invoice Settings Service
// =============================================================================
// Manages per-organization invoice branding settings stored in the
// organization_invoice_settings table (migration 204).
// =============================================================================

const db = require('../config/database');
const { ValidationError } = require('../utils/errors');

/**
 * Get invoice settings for an organization.
 * Returns null if no custom settings have been saved yet.
 * @param {number} organizationId
 * @returns {Promise<object|null>}
 */
async function getInvoiceSettings(organizationId) {
  const [rows] = await db.query(
    'SELECT * FROM organization_invoice_settings WHERE organization_id = ?',
    [organizationId],
  );
  return rows[0] || null;
}

/**
 * Upsert invoice settings for an organization.
 * @param {number} organizationId
 * @param {{ logo_url?, header_color?, footer_legal?, payment_instructions?, number_prefix? }} data
 * @returns {Promise<object>}
 */
async function upsertInvoiceSettings(organizationId, data) {
  const { logo_url, header_color, footer_legal, payment_instructions } = data;
  // Left out of the request, the prefix is kept; sent empty, it goes back to
  // the organization's default.
  const prefixSent = data.number_prefix !== undefined;
  const prefix = prefixSent ? cleanPrefix(data.number_prefix) : null;

  await db.query(
    `INSERT INTO organization_invoice_settings
        (organization_id, logo_url, header_color, footer_legal, payment_instructions, number_prefix)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        logo_url             = VALUES(logo_url),
        header_color         = VALUES(header_color),
        footer_legal         = VALUES(footer_legal),
        payment_instructions = VALUES(payment_instructions),
        number_prefix        = IF(?, VALUES(number_prefix), number_prefix),
        updated_at           = CURRENT_TIMESTAMP`,
    [organizationId, logo_url || null, header_color || null, footer_legal || null, payment_instructions || null,
      prefix, prefixSent ? 1 : 0],
  );

  return getInvoiceSettings(organizationId);
}

// ---------------------------------------------------------------------------
// The prefix of invoice numbers (migration 042)
// ---------------------------------------------------------------------------
// REM-000123: the letters an organization chose, a dash, and its running
// number. With none chosen a Mexican organization uses REM (the document is a
// remisión; the fiscal invoice is the CFDI) and any other uses INV.

const DEFAULT_PREFIX = { MX: 'REM' };
const FALLBACK_PREFIX = 'INV';
const defaultPrefixFor = (locale) => DEFAULT_PREFIX[locale] || FALLBACK_PREFIX;

/** A prefix as it is stored: upper case, 1 to 10 letters, digits or dashes, starting with a letter or digit. Empty = none. */
function cleanPrefix(raw) {
  if (raw === null) return null;
  const value = String(raw).trim().toUpperCase().replace(/-+$/, '');
  if (!value) return null;
  if (!/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(value)) {
    throw new ValidationError('number_prefix: use 1 to 10 letters, digits or dashes, starting with a letter or a digit');
  }
  return value;
}

/**
 * The prefix an organization's next invoice number takes, with what it would
 * be by default. `exec` lets the caller read inside its own transaction.
 */
async function numberPrefix(organizationId, exec = db.query.bind(db)) {
  if (organizationId === null || organizationId === undefined) {
    return { chosen: null, fallback: FALLBACK_PREFIX, effective: FALLBACK_PREFIX };
  }
  const [rows] = await exec(
    `SELECT s.number_prefix, o.locale
       FROM organizations o
       LEFT JOIN organization_invoice_settings s ON s.organization_id = o.id
      WHERE o.id = ? AND o.deleted_at IS NULL`,
    [organizationId],
  );
  const row = (rows && rows[0]) || {};
  const fallback = defaultPrefixFor(row.locale);
  const chosen = row.number_prefix || null;
  return { chosen, fallback, effective: chosen || fallback };
}

module.exports = { getInvoiceSettings, upsertInvoiceSettings, numberPrefix, cleanPrefix, defaultPrefixFor };
