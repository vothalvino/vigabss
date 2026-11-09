// =============================================================================
// VigaBSS 5.0 — Collector accounts ("Cobrador", migration 011)
// =============================================================================
// A collector is a top-level row of `resellers` with kind = 'collector': a
// point that only takes payments, with its own cash limit, ledger, cash box,
// cash bags and statements. It never owns clients, leads or sub-resellers, it
// cannot see the ISP's clients or counts, and it finds a customer only by the
// exact client number (resellerCollectionService.lookup).
//
// For each payment it takes it earns a fee, set per collector: a fixed amount
// or a percentage of the amount collected (2 decimals, half up), never more
// than the amount. The fee is kept from the cash: a collection_fee ledger
// line of -fee posted in the collection's transaction, reversed
// (collection_fee_reversal, +fee) when the collection is voided.
// =============================================================================

const db = require('../config/database');
const money = require('../utils/money');
const { requireOrgId } = require('../utils/requireOrgId');
const { ValidationError } = require('../utils/errors');
const { businessDayStartUtc, businessToday } = require('../utils/businessDate');

const KINDS = ['reseller', 'collector'];
const FEE_TYPES = ['none', 'fixed', 'percent'];
const MAX_PERCENT = 100;
const MAX_FIXED = 99999999.99;

const toMoney = (v) => money.round(v === null || v === undefined || v === '' ? 0 : v);

/** The fee a collector earns on `amount` (0 for a reseller or no fee). */
function feeFor(point, amount) {
  if (!point || point.kind !== 'collector') return 0;
  const value = toMoney(point.collection_fee_value);
  if (!(value > 0)) return 0;
  const amt = toMoney(amount);
  let fee = 0;
  if (point.collection_fee_type === 'fixed') fee = value;
  else if (point.collection_fee_type === 'percent') fee = money.round((amt * value) / 100);
  return Math.min(toMoney(fee), amt);
}

/**
 * The validated fee settings of a create/update body, or null when the body
 * sets neither. A reseller keeps 'none'.
 */
function feeSettings(body, kind) {
  const hasType = body.collection_fee_type !== undefined;
  const hasValue = body.collection_fee_value !== undefined;
  if (!hasType && !hasValue) return null;
  if (kind !== 'collector') {
    if ((hasType && body.collection_fee_type !== 'none') || (hasValue && Number(body.collection_fee_value) !== 0)) {
      throw new ValidationError('collection_fee_type: only a collector earns a collection fee');
    }
    return { type: 'none', value: 0 };
  }
  const type = hasType ? body.collection_fee_type : null;
  if (type !== null && !FEE_TYPES.includes(type)) throw new ValidationError(`collection_fee_type must be one of ${FEE_TYPES.join(', ')}`);
  const value = hasValue ? Number(body.collection_fee_value) : null;
  if (value !== null && (!Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100)) {
    throw new ValidationError('collection_fee_value must be a number of at most 2 decimals, 0 or more');
  }
  if (type === 'percent' && value !== null && value > MAX_PERCENT) throw new ValidationError('collection_fee_value: a percentage is at most 100');
  if (type === 'fixed' && value !== null && value > MAX_FIXED) throw new ValidationError('collection_fee_value is too large');
  return { type, value };
}

/** kind and fee settings of one reseller row, on `exec` (null when gone). */
async function pointRow(exec, orgId, resellerId) {
  requireOrgId(orgId, 'collectorService.pointRow');
  const result = await exec(
    'SELECT id, kind, collection_fee_type, collection_fee_value FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [resellerId, orgId],
  );
  const rows = Array.isArray(result) ? result[0] : null;
  return rows && rows[0] ? rows[0] : null;
}

/** 'collector' or 'reseller' for a reseller id (reseller when unknown). */
async function kindOf(orgId, resellerId, exec = db.query.bind(db)) {
  if (resellerId === null || resellerId === undefined) return 'reseller';
  const row = await pointRow(exec, orgId, resellerId);
  return row && row.kind === 'collector' ? 'collector' : 'reseller';
}

/**
 * Refuse to make a collector the owner of a client or a lead (or the parent
 * of a sub-reseller): a collector only takes payments.
 */
async function assertCanOwnClients(orgId, resellerId, exec = db.query.bind(db), what = 'reseller_id') {
  if (resellerId === null || resellerId === undefined || resellerId === '') return;
  if ((await kindOf(orgId, Number(resellerId), exec)) === 'collector') {
    const err = new ValidationError(`${what}: a collector only takes payments; it cannot own clients, leads or sub-resellers`);
    err.code = 'COLLECTOR_CANNOT_OWN';
    throw err;
  }
}

/** The fees a collector kept this business month (reversed ones excluded). */
async function feesThisMonth(orgId, resellerId, exec = db.query.bind(db)) {
  requireOrgId(orgId, 'collectorService.feesThisMonth');
  const [rows] = await exec(
    `SELECT COALESCE(-SUM(amount), 0) AS total
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ?
        AND entry_type IN ('collection_fee', 'collection_fee_reversal')
        AND created_at >= ?`,
    [orgId, resellerId, businessDayStartUtc(`${businessToday().slice(0, 7)}-01`)],
  );
  return toMoney(rows && rows[0] ? rows[0].total : 0);
}

module.exports = {
  KINDS,
  FEE_TYPES,
  feeFor,
  feeSettings,
  pointRow,
  kindOf,
  assertCanOwnClients,
  feesThisMonth,
};
