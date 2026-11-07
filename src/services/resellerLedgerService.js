// =============================================================================
// VigaBSS 5.0 — Reseller cash ledger (reseller app, phase 2)
// =============================================================================
// A reseller (Punto de Venta) collects cash for the ISP and holds it until it
// hands it in. reseller_ledger_entries is the append-only record of that,
// per COLLECTING reseller: the top-level reseller of the user who took the
// money, whichever reseller owns the client. Amounts are signed:
//
//   collection        +amount   cash taken from a subscriber
//   collection_void   -amount   that collection voided the same day
//   deposit           -amount   cash handed in to the ISP
//   adjustment        +/-       a correction, with a note
//   bag_sealed        -declared cash sealed in a cash bag (phase 3,
//                               migration 006; only cashBagService.seal posts it)
//
// Every figure the app and the staff pages show comes from here:
//
//   balance              = SUM(amount)          what the reseller owes the ISP
//   cash_on_hand         = balance              the cash it still holds
//   in_bags              = SUM(cash_bags.declared_amount) of its bags sealed
//                          and not yet received (ready_for_pickup, in_transit);
//                          shown for information, subtracted nowhere
//   credit_limit         = COALESCE(resellers.credit_limit,
//                                   reseller_default_credit_limit setting)
//   available_to_collect = max(0, credit_limit - cash_on_hand)
//
// Sealing a bag (phase 3, services/cashBagService.js) takes its declared
// amount off the reseller's ledger at once (a bag_sealed entry of -D), which
// frees the limit: the cash is no longer the reseller's but the bag's, on its
// way to the ISP. Receiving the bag posts only the difference with the count
// (an adjustment of D - C); a lost bag posts nothing, so the ISP absorbs it.
//
// Rows are never updated or deleted; a correction is a new entry. A writer
// locks the reseller row first (lockReseller) so the credit check and the
// entry it guards cannot interleave with another collection, deposit or seal.
// =============================================================================

const db = require('../config/database');
const money = require('../utils/money');
const { requireOrgId } = require('../utils/requireOrgId');
const { inPlaceholders } = require('../utils/sqlBuild');
const { ORG_SETTING_DEFS } = require('./settingsCatalog');

const ENTRY_TYPES = ['collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed'];
// What staff may post by hand (POST /resellers/:id/ledger); every other type
// is written by the flow it records (a collection, its void, a sealed bag).
const MANUAL_ENTRY_TYPES = ['deposit', 'adjustment'];
const DEFAULT_LIMIT_KEY = 'reseller_default_credit_limit';

const defaultExec = () => db.query.bind(db);
const toMoney = (value) => money.round(value === null || value === undefined || value === '' ? 0 : value);

/** The organization default credit limit (the setting, else the catalog default). */
async function defaultCreditLimit(orgId, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.defaultCreditLimit');
  const [rows] = await exec(
    `SELECT setting_value FROM organization_settings
      WHERE organization_id = ? AND setting_key = 'reseller_default_credit_limit'`,
    [orgId],
  );
  const stored = rows && rows[0] ? rows[0].setting_value : null;
  const def = ORG_SETTING_DEFS[DEFAULT_LIMIT_KEY];
  const value = stored !== null && stored !== undefined && def.validate(String(stored)) === null ? stored : def.default;
  return toMoney(value);
}

/** COALESCE(the reseller's own limit, the organization default). */
function effectiveCreditLimit(ownLimit, orgDefault) {
  return ownLimit === null || ownLimit === undefined ? toMoney(orgDefault) : toMoney(ownLimit);
}

/**
 * The top-level reseller of `resellerId`: itself, or its parent when it is a
 * sub-reseller (the hierarchy has two levels). Cash is booked on it, and its
 * allowed plans apply to its sub-resellers too.
 */
async function topLevelResellerId(orgId, resellerId) {
  requireOrgId(orgId, 'resellerLedgerService.topLevelResellerId');
  const [rows] = await db.query(
    'SELECT id, parent_id FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [resellerId, orgId],
  );
  const reseller = rows && rows[0];
  if (!reseller || reseller.parent_id === null || reseller.parent_id === undefined) return Number(resellerId);
  const [parents] = await db.query(
    'SELECT id, parent_id FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [reseller.parent_id, orgId],
  );
  return parents && parents[0] ? Number(parents[0].id) : Number(resellerId);
}

const COLLECTING_RESELLER = Symbol('collectingReseller');

/**
 * The reseller a bound user's money is booked on: the top-level reseller of
 * its binding (req.resellerScope.rootId may be a sub-reseller). Memoized on
 * the request.
 */
async function collectingResellerId(req) {
  const bound = req.resellerScope && req.resellerScope.rootId;
  const key = `${req.orgId}:${bound}`;
  if (req[COLLECTING_RESELLER] && req[COLLECTING_RESELLER].key === key) return req[COLLECTING_RESELLER].id;
  const id = await topLevelResellerId(req.orgId, bound);
  req[COLLECTING_RESELLER] = { key, id };
  return id;
}

/**
 * The figures derived from a balance, a limit and the cash in sealed bags.
 * Sealed cash already left the balance (bag_sealed), so in_bags is reported
 * as it is and not subtracted: cash_on_hand is the balance.
 */
function summarize(balance, creditLimit, inBagsAmount = 0) {
  const cashOnHand = toMoney(balance);
  const limit = toMoney(creditLimit);
  return {
    balance: cashOnHand,
    in_bags: toMoney(inBagsAmount),
    cash_on_hand: cashOnHand,
    credit_limit: limit,
    available_to_collect: Math.max(0, money.sub(limit, cashOnHand)),
  };
}

// Bags whose declared cash has left the reseller's hands (and ledger) but not reached the ISP.
const IN_BAGS_STATUSES = ['ready_for_pickup', 'in_transit'];

/** SUM(declared_amount) of the reseller's sealed, not yet received bags, on `exec`. */
async function inBags(orgId, resellerId, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.inBags');
  const [rows] = await exec(
    `SELECT COALESCE(SUM(declared_amount), 0) AS in_bags
       FROM cash_bags
      WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL
        AND status IN ('ready_for_pickup', 'in_transit')`,
    [orgId, resellerId],
  );
  return toMoney(rows && rows[0] ? rows[0].in_bags : 0);
}

/** in_bags of several resellers of one organization, as Map(id → amount). */
async function inBagsFor(orgId, resellerIds, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.inBagsFor');
  const ids = [...new Set((resellerIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const [rows] = await exec(
    `SELECT reseller_id, COALESCE(SUM(declared_amount), 0) AS in_bags
       FROM cash_bags
      WHERE organization_id = ? AND reseller_id IN (${inPlaceholders(ids)}) AND deleted_at IS NULL
        AND status IN ('ready_for_pickup', 'in_transit')
      GROUP BY reseller_id`,
    [orgId, ...ids],
  );
  for (const r of rows || []) out.set(Number(r.reseller_id), toMoney(r.in_bags));
  return out;
}

/**
 * How many of the reseller's bags are in each live status:
 * { at_reseller (empty bags it may fill), ready_for_pickup, in_transit }.
 */
async function bagCounts(orgId, resellerId, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.bagCounts');
  const [rows] = await exec(
    `SELECT COALESCE(SUM(status = 'at_reseller'), 0) AS at_reseller,
            COALESCE(SUM(status = 'ready_for_pickup'), 0) AS ready_for_pickup,
            COALESCE(SUM(status = 'in_transit'), 0) AS in_transit
       FROM cash_bags
      WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL
        AND status IN ('at_reseller', 'ready_for_pickup', 'in_transit')`,
    [orgId, resellerId],
  );
  const row = (rows && rows[0]) || {};
  return {
    at_reseller: Number(row.at_reseller) || 0,
    ready_for_pickup: Number(row.ready_for_pickup) || 0,
    in_transit: Number(row.in_transit) || 0,
  };
}

/** SUM(amount) of a reseller's entries, on `exec` (the caller's transaction or the pool). */
async function ledgerBalance(orgId, resellerId, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.ledgerBalance');
  const [rows] = await exec(
    `SELECT COALESCE(SUM(amount), 0) AS balance
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ?`,
    [orgId, resellerId],
  );
  return toMoney(rows && rows[0] ? rows[0].balance : 0);
}

/**
 * Lock the reseller row for the rest of the caller's transaction and return
 * { id, name, status, credit_limit, parent_id }, or null when it is not a live
 * reseller of the organization.
 */
async function lockReseller(exec, orgId, resellerId) {
  requireOrgId(orgId, 'resellerLedgerService.lockReseller');
  const [rows] = await exec(
    `SELECT id, name, status, credit_limit, parent_id FROM resellers
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
      FOR UPDATE`,
    [resellerId, orgId],
  );
  return rows && rows[0] ? rows[0] : null;
}

/**
 * The summary of one reseller: { balance, in_bags, cash_on_hand, credit_limit,
 * available_to_collect, credit_limit_override }. credit_limit is the effective
 * limit; credit_limit_override is the reseller's own (null = the default).
 * Pass `reseller` (a row with credit_limit) when it is already loaded.
 */
async function summaryFor(orgId, resellerId, { exec = defaultExec(), reseller = null } = {}) {
  requireOrgId(orgId, 'resellerLedgerService.summaryFor');
  let row = reseller;
  if (!row) {
    const [rows] = await exec(
      'SELECT id, credit_limit FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [resellerId, orgId],
    );
    row = rows && rows[0] ? rows[0] : { credit_limit: null };
  }
  // One after the other: `exec` may be a transaction's connection.
  const balance = await ledgerBalance(orgId, resellerId, exec);
  const bagged = await inBags(orgId, resellerId, exec);
  const orgDefault = row.credit_limit === null || row.credit_limit === undefined ? await defaultCreditLimit(orgId, exec) : null;
  return {
    ...summarize(balance, effectiveCreditLimit(row.credit_limit, orgDefault), bagged),
    credit_limit_override: row.credit_limit === null || row.credit_limit === undefined ? null : toMoney(row.credit_limit),
  };
}

/** Ledger balances of several resellers of one organization, as Map(id → balance). */
async function balancesFor(orgId, resellerIds, exec = defaultExec()) {
  requireOrgId(orgId, 'resellerLedgerService.balancesFor');
  const ids = [...new Set((resellerIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const [rows] = await exec(
    `SELECT reseller_id, COALESCE(SUM(amount), 0) AS balance
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id IN (${inPlaceholders(ids)})
      GROUP BY reseller_id`,
    [orgId, ...ids],
  );
  for (const r of rows || []) out.set(Number(r.reseller_id), toMoney(r.balance));
  return out;
}

/**
 * Append one entry on the caller's transaction. The sign of `amount` is the
 * caller's: + for a collection, - for a void or a deposit.
 * @returns {Promise<number>} the new entry id
 */
async function appendEntry(exec, {
  orgId, resellerId, entryType, amount, currency, paymentId = null, cashSessionId = null, note = null, createdBy,
  cashBagId = null,
}) {
  requireOrgId(orgId, 'resellerLedgerService.appendEntry');
  if (!ENTRY_TYPES.includes(entryType)) throw new Error(`Unknown reseller ledger entry type: ${entryType}`);
  // cash_bag_id goes last, so the column order of phase 2 is unchanged.
  const [result] = await exec(
    `INSERT INTO reseller_ledger_entries
       (organization_id, reseller_id, entry_type, amount, currency, payment_id, cash_session_id, note, created_by, cash_bag_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, resellerId, entryType, toMoney(amount), currency, paymentId, cashSessionId, note, createdBy, cashBagId],
  );
  return result.insertId;
}

function entryRow(r) {
  return {
    id: Number(r.id),
    entry_type: r.entry_type,
    amount: toMoney(r.amount),
    currency: r.currency,
    note: r.note ?? null,
    created_at: r.created_at,
    payment_id: r.payment_id === null || r.payment_id === undefined ? null : Number(r.payment_id),
    cash_session_id: r.cash_session_id === null || r.cash_session_id === undefined ? null : Number(r.cash_session_id),
    created_by: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
    cash_bag_id: r.cash_bag_id === null || r.cash_bag_id === undefined ? null : Number(r.cash_bag_id),
    cash_bag_serial: r.cash_bag_serial ?? null,
  };
}

/** Set cash_bag_serial on the rows that name a bag (its seal, and the difference or legacy deposit of its receipt). */
async function withBagSerials(orgId, rows) {
  const ids = [...new Set((rows || []).map((r) => Number(r.cash_bag_id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return rows;
  const [bags] = await db.query(
    `/* includes deleted rows: a ledger line keeps naming the bag it was posted for */
     SELECT id, serial FROM cash_bags WHERE organization_id = ? AND id IN (${inPlaceholders(ids)})`,
    [orgId, ...ids],
  );
  const serials = new Map((bags || []).map((b) => [Number(b.id), b.serial]));
  for (const r of rows) {
    if (r.cash_bag_id !== null && r.cash_bag_id !== undefined) r.cash_bag_serial = serials.get(Number(r.cash_bag_id)) ?? null;
  }
  return rows;
}

/** A page of a reseller's entries, newest first: { rows, total }. */
async function listEntries(orgId, resellerId, { limit, offset }) {
  requireOrgId(orgId, 'resellerLedgerService.listEntries');
  const [rows] = await db.query(
    `SELECT id, entry_type, amount, currency, note, created_at, payment_id, cash_session_id, created_by, cash_bag_id
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [orgId, resellerId],
  );
  await withBagSerials(orgId, rows);
  const [[count]] = await db.query(
    'SELECT COUNT(*) AS total FROM reseller_ledger_entries WHERE organization_id = ? AND reseller_id = ?',
    [orgId, resellerId],
  );
  return { rows: (rows || []).map(entryRow), total: Number(count?.total) || 0 };
}

module.exports = {
  ENTRY_TYPES,
  MANUAL_ENTRY_TYPES,
  defaultCreditLimit,
  effectiveCreditLimit,
  topLevelResellerId,
  collectingResellerId,
  summarize,
  IN_BAGS_STATUSES,
  inBags,
  inBagsFor,
  bagCounts,
  ledgerBalance,
  lockReseller,
  summaryFor,
  balancesFor,
  appendEntry,
  listEntries,
  withBagSerials,
  entryRow,
};
