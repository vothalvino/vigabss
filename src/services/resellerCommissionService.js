// =============================================================================
// VigaBSS 5.0 — Reseller commissions (reseller program, phase 4, migration 007)
// =============================================================================
// A reseller (Punto de Venta) earns commission_rate % of the SUBTOTAL
// (excluding taxes, in the invoice currency, rounded to cents) of every paid
// invoice of a client it brought in (clients.reseller_id), whoever collected
// the money: staff, a gateway, another reseller, the portal. The rate and the
// account are those of the TOP-LEVEL reseller (the root of parent_id), also
// for clients of its sub-resellers. The reseller keeps the commission from
// the cash it holds, so it is a line of its cash ledger
// (resellerLedgerService):
//
//   invoice becomes paid        reseller_commissions row earned (inserted, or
//                               a reversed row restored: reversed_at cleared)
//                               + ledger 'commission' of -amount
//   invoice stops being paid    the standing row reversed (reversed_at set)
//                               + ledger 'commission_reversal' of +amount
//   anything else               nothing
//
// No commission: a client without a reseller, a reseller that is deleted, a
// top-level rate of 0, a zero subtotal, an invoice in another currency than
// the organization's (the ledger is in the organization currency), or an
// invoice paid before the engine went live: the organization setting
// reseller_commissions_since (migration 007) is the go-live point, and only
// an invoice whose paid_at is at or after it earns (no backfill; an
// organization without the row, created after the upgrade, earns from its
// creation; an invoice without paid_at, such as an imported 'paid' one,
// never earns). paid_at is written only by the paid-status recomputes: the
// invoice routes drop it from a hand edit.
//
// syncResellerCommission(exec, invoiceId, orgId) RECONCILES the commission
// with the invoice as it now stands, inside the caller's transaction (exec is
// that transaction's bound query function). It is idempotent: the decision is
// derived from the invoice row and the commission row, both read under a row
// lock, and every state change is a conditional write whose affectedRows says
// whether this call made it, so two hooks for one invoice (repeated, or
// concurrent) post one line per transition. Every place that changes an
// invoice's paid state calls it, in both directions, inside its transaction
// (see ARCHITECTURE.md, "Reseller commissions").
//
// Lock order, the same in every transaction that touches reseller money:
//
//   payment -> invoices -> reseller rows -> commission row / cash bag
//
// 1. The invoice is locked FOR UPDATE first. The caller already holds it (it
//    has just updated its status), so this serializes every sync of one
//    invoice. To EARN, the commission row is then found by a plain read and
//    re-read FOR UPDATE by primary key, which takes record locks only: a
//    locking read of a missing (reseller, invoice) key would take a gap lock,
//    and two syncs of different invoices inserting into one gap would
//    deadlock (a row the stale snapshot misses hits the unique key instead).
//    To REVERSE, nothing is inserted, so the rows are found by a locking
//    read: the caller's snapshot may predate a row committed before it got
//    the invoice lock (lockRowsToReverse), and the resellers it books to are
//    share-locked before that read.
// 2. The engine takes reseller rows in SHARE mode only (explicitly for the
//    earning reseller and the resellers of a reversal, and through the
//    foreign key checks of its inserts).
//    Share locks never conflict with each other, so syncs of invoices of
//    different resellers, in any order, never wait for one another.
// 3. A writer of one reseller's own money takes that row FOR UPDATE: a
//    collection, its void, a deposit, a payout, a cash bag. A collection and
//    a void lock their invoices BEFORE the reseller rows (phase 2 had it the
//    other way round), and lock their own reseller FOR UPDATE and the owner
//    of the client in share mode in ascending id order
//    (resellerLedgerService.lockResellers). Deposits, payouts and bags lock no
//    invoice. So no transaction holds an exclusive reseller lock while it
//    waits for an invoice, and a commission sync that holds invoices and waits
//    for a reseller always waits for a transaction that is not waiting for it.
// 4. Paths that settle several invoices lock them all before the first sync:
//    the allocators lock every invoice up front, and the paid-status
//    recomputes that loop (reversePaymentAllocations, a refund, a credit note
//    moved between invoices) update every invoice first and sync after.
// =============================================================================

const db = require('../config/database');
const money = require('../utils/money');
const logger = require('../utils/logger').child({ service: 'resellerCommission' });
const { requireOrgId } = require('../utils/requireOrgId');
const { inPlaceholders } = require('../utils/sqlBuild');
const { businessToday, businessDayStartUtc } = require('../utils/businessDate');
const ledger = require('./resellerLedgerService');

const COMMISSIONS_SINCE_KEY = 'reseller_commissions_since';
// The hierarchy has two levels; the walk stops well before a corrupt loop.
const MAX_PARENT_DEPTH = 8;

const NONE = Object.freeze({ action: 'none' });

const rowsOf = (result) => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []);
const headerOf = (result) => (Array.isArray(result) ? result[0] : result) || {};

/** A mysql2 TIMESTAMP (Date) or a 'YYYY-MM-DD HH:MM:SS' UTC string, as epoch ms; null when absent. */
function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const text = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** rate % of base, rounded half up to cents. rate is a DECIMAL(5,2) value. */
function commissionAmount(base, rate) {
  return money.mul(base, `${String(rate).trim()}e-2`);
}

/**
 * The top-level reseller of `resellerId` and its rate, or null when the
 * reseller is not live. Walks parent_id to the root through live resellers.
 */
async function topLevelReseller(exec, orgId, resellerId) {
  let current = null;
  let nextId = Number(resellerId);
  const seen = new Set();
  for (let depth = 0; depth < MAX_PARENT_DEPTH && Number.isInteger(nextId) && nextId > 0 && !seen.has(nextId); depth += 1) {
    seen.add(nextId);
    const [rows] = await exec(
      'SELECT id, parent_id FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [nextId, orgId],
    );
    const row = rows && rows[0];
    if (!row) break;
    current = row;
    nextId = row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id);
  }
  return current ? Number(current.id) : null;
}

/**
 * The top-level reseller that earns the commissions of a client's invoices,
 * or null when the client has no live reseller. Plain reads: callers that lock
 * reseller rows in order (a collection, a void) use it to know which one.
 */
async function commissionResellerForClient(exec, orgId, clientId) {
  requireOrgId(orgId, 'resellerCommissionService.commissionResellerForClient');
  const [rows] = await exec(
    `/* includes deleted rows: an archived client's invoices still earn its reseller's commission */
     SELECT reseller_id FROM clients WHERE id = ? AND organization_id = ?`,
    [clientId, orgId],
  );
  const client = rows && rows[0];
  if (!client || client.reseller_id === null || client.reseller_id === undefined) return null;
  return topLevelReseller(exec, orgId, client.reseller_id);
}

/**
 * Who earns what on a paid invoice: { resellerId, rate, base, amount,
 * currency } or null when nothing is earned. Locks the earning reseller row
 * in share mode and reads its rate under that lock.
 */
async function commissionTerms(exec, orgId, invoice) {
  const [orgRows] = await exec(
    `SELECT o.currency, o.created_at, s.setting_value AS commissions_since
       FROM organizations o
       LEFT JOIN organization_settings s ON s.organization_id = o.id AND s.setting_key = ?
      WHERE o.id = ? AND o.deleted_at IS NULL`,
    [COMMISSIONS_SINCE_KEY, orgId],
  );
  const org = orgRows && orgRows[0];
  if (!org) return null;
  // The go-live point: the setting migration 007 wrote, else (an organization
  // created after the upgrade) the organization's creation. An invoice
  // without paid_at was never paid through the system (an import) and never
  // earns, whatever the setting.
  const since = instant(org.commissions_since) ?? instant(org.created_at);
  const paidAt = instant(invoice.paid_at);
  if (paidAt === null || (since !== null && paidAt < since)) return null;
  if (org.currency && invoice.currency && String(org.currency).toUpperCase() !== String(invoice.currency).toUpperCase()) {
    return null;
  }

  const resellerId = await commissionResellerForClient(exec, orgId, invoice.client_id);
  if (!resellerId) return null;
  const [resellerRows] = await exec(
    `SELECT id, commission_rate FROM resellers
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
      LOCK IN SHARE MODE`,
    [resellerId, orgId],
  );
  const reseller = resellerRows && resellerRows[0];
  if (!reseller) return null;
  const rate = money.round(reseller.commission_rate === null || reseller.commission_rate === undefined ? 0 : reseller.commission_rate);
  if (!(rate > 0)) return null;
  const base = money.round(invoice.subtotal === null || invoice.subtotal === undefined ? 0 : invoice.subtotal);
  const amount = commissionAmount(base, rate);
  if (!(amount > 0)) return null;
  return { resellerId, rate, base, amount, currency: invoice.currency || org.currency };
}

async function lockCommissionRows(exec, orgId, ids) {
  if (!ids.length) return [];
  const [rows] = await exec(
    `SELECT id, reseller_id, invoice_id, commission_amount, currency, status, reversed_at
       FROM reseller_commissions
      WHERE organization_id = ? AND id IN (${inPlaceholders(ids)})
      FOR UPDATE`,
    [orgId, ...ids],
  );
  return rows || [];
}

/**
 * The commission rows of an invoice that is not paid, read and locked by a
 * CURRENT read. The plain read the caller's snapshot answers can miss a row
 * another transaction committed before this one got the invoice lock: most
 * un-pay paths make their first plain read (which fixes the REPEATABLE READ
 * snapshot) before they lock the invoice, and a reversal that misses the row
 * leaves the commission standing on an unpaid invoice. The locking read may
 * take a gap lock (the key can be missing), which only makes a concurrent
 * insert into that gap wait: this branch inserts no commission row. The
 * resellers it may book a reversal for (those of the rows the snapshot shows
 * and the client's commission reseller) are share-locked FIRST, in id order,
 * as the lock order says (reseller rows, then the commission row): so it never
 * holds the gap while it waits for a reseller that an inserter holds FOR
 * UPDATE (a collection of that reseller, inserting into the same gap).
 * Without any such reseller no row can have been earned and nothing is locked.
 */
async function lockRowsToReverse(exec, orgId, invoice, found) {
  const owner = await commissionResellerForClient(exec, orgId, invoice.client_id);
  const resellerIds = [...new Set([...found.map((r) => Number(r.reseller_id)), ...(owner ? [owner] : [])])]
    .filter((rid) => Number.isInteger(rid) && rid > 0)
    .sort((a, b) => a - b);
  if (!resellerIds.length) return [];
  await exec(
    `/* includes deleted rows: a lock only; a reversal books to the reseller that earned, live or not */
     SELECT id FROM resellers
      WHERE organization_id = ? AND id IN (${inPlaceholders(resellerIds)})
      ORDER BY id
      LOCK IN SHARE MODE`,
    [orgId, ...resellerIds],
  );
  const [rows] = await exec(
    `SELECT id, reseller_id, invoice_id, commission_amount, currency, status, reversed_at
       FROM reseller_commissions
      WHERE organization_id = ? AND invoice_id = ?
      ORDER BY id
      FOR UPDATE`,
    [orgId, Number(invoice.id)],
  );
  return rows || [];
}

const standingRow = (r) => r && (r.reversed_at === null || r.reversed_at === undefined) && r.status !== 'reversed';

async function postLine(exec, { orgId, resellerId, entryType, amount, currency, invoiceId, commissionId, note }) {
  return ledger.appendEntry(exec, {
    orgId, resellerId, entryType, amount, currency, note, createdBy: null, invoiceId, commissionId,
  });
}

async function reverse(exec, orgId, invoice, row) {
  const [res] = await exec(
    `UPDATE reseller_commissions SET status = 'reversed', reversed_at = NOW()
      WHERE id = ? AND organization_id = ? AND reversed_at IS NULL`,
    [row.id, orgId],
  );
  if (!res || res.affectedRows !== 1) return null;
  const amount = money.round(row.commission_amount);
  const entryId = await postLine(exec, {
    orgId, resellerId: Number(row.reseller_id), entryType: 'commission_reversal', amount, currency: row.currency,
    invoiceId: Number(invoice.id), commissionId: Number(row.id),
    note: `Factura ${invoice.invoice_number || invoice.id} ya no está pagada`,
  });
  return { action: 'reversed', commissionId: Number(row.id), resellerId: Number(row.reseller_id), amount, entryId };
}

async function earn(exec, orgId, invoice, terms, entryType) {
  return postLine(exec, {
    orgId, resellerId: terms.resellerId, entryType, amount: -terms.amount, currency: terms.currency,
    invoiceId: Number(invoice.id), commissionId: terms.commissionId,
    note: `Comisión ${terms.rate}% de la factura ${invoice.invoice_number || invoice.id}`,
  });
}

/** Restore a reversed row for a new payment of its invoice; null when another call already did. */
async function restore(exec, orgId, invoice, row, terms) {
  const [res] = await exec(
    `UPDATE reseller_commissions
        SET status = 'earned', reversed_at = NULL, earned_at = NOW(), client_id = ?, commission_rate = ?,
            base_amount = ?, invoice_total = ?, commission_amount = ?, currency = ?
      WHERE id = ? AND organization_id = ? AND reversed_at IS NOT NULL`,
    [invoice.client_id, terms.rate, terms.base, money.round(invoice.total || 0), terms.amount, terms.currency, row.id, orgId],
  );
  if (!res || res.affectedRows !== 1) return null;
  const withId = { ...terms, commissionId: Number(row.id) };
  const entryId = await earn(exec, orgId, invoice, withId, 'commission');
  return { action: 'restored', commissionId: Number(row.id), resellerId: terms.resellerId, amount: terms.amount, entryId };
}

const isDuplicate = (err) => Boolean(err) && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);

/**
 * Reconcile the commission of one invoice with its paid state, inside the
 * caller's transaction. See the header for the rules and the lock order.
 *
 * @param {Function} exec  bound query function of the caller's transaction
 * @param {number|string} invoiceId
 * @param {number} orgId   the invoice's organization (undefined throws)
 * @param {{ unpaid?: boolean }} [opts] unpaid: the caller is taking the
 *   invoice out of 'paid' in this transaction in a way its row does not show
 *   yet (it is about to be deleted)
 * @returns {Promise<{action: 'earned'|'restored'|'reversed'|'none', commissionId?: number,
 *   resellerId?: number, amount?: number, entryId?: number}>}
 */
async function syncResellerCommission(exec, invoiceId, orgId, { unpaid = false } = {}) {
  requireOrgId(orgId, 'resellerCommissionService.syncResellerCommission');
  const id = Number(invoiceId);
  // A single-tenant (NULL organization) install has no reseller ledger.
  if (orgId === null || !Number.isInteger(id) || id < 1) return NONE;

  const invoiceRows = rowsOf(await exec(
    `/* includes deleted rows: a deleted invoice is not paid, and its commission is reversed */
     SELECT id, client_id, invoice_number, status, subtotal, total, currency, paid_at, deleted_at
       FROM invoices WHERE id = ? AND organization_id = ?
       FOR UPDATE`,
    [id, orgId],
  ));
  const invoice = invoiceRows[0];
  if (!invoice) return NONE;
  const earning = !unpaid && invoice.status === 'paid' && !invoice.deleted_at;

  const found = rowsOf(await exec(
    'SELECT id, reseller_id FROM reseller_commissions WHERE organization_id = ? AND invoice_id = ?',
    [orgId, id],
  ));

  if (!earning) {
    let result = NONE;
    const toReverse = (await lockRowsToReverse(exec, orgId, invoice, found)).filter(standingRow);
    for (const row of toReverse) {
      const done = await reverse(exec, orgId, invoice, row);
      if (done) result = done;
    }
    return result;
  }
  const rows = await lockCommissionRows(exec, orgId, found.map((r) => Number(r.id)));
  const standing = rows.filter(standingRow);
  if (standing.length) return { action: 'none', commissionId: Number(standing[0].id), resellerId: Number(standing[0].reseller_id) };

  const terms = await commissionTerms(exec, orgId, invoice);
  if (!terms) return NONE;

  const reversed = rows.find((r) => Number(r.reseller_id) === terms.resellerId);
  if (reversed) return (await restore(exec, orgId, invoice, reversed, terms)) || NONE;

  let insertId;
  try {
    const [res] = await exec(
      `INSERT INTO reseller_commissions
         (organization_id, reseller_id, invoice_id, client_id, commission_rate, base_amount, invoice_total,
          commission_amount, currency, status, earned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'earned', NOW())`,
      [orgId, terms.resellerId, id, invoice.client_id, terms.rate, terms.base, money.round(invoice.total || 0),
        terms.amount, terms.currency],
    );
    insertId = Number(res.insertId);
  } catch (err) {
    if (!isDuplicate(err)) throw err;
    // Our snapshot predates a row another transaction committed while we
    // waited for the invoice lock: the row exists now, so this locking read
    // takes a record lock and sees it.
    const [again] = await exec(
      `SELECT id, reseller_id, invoice_id, commission_amount, currency, status, reversed_at
         FROM reseller_commissions
        WHERE organization_id = ? AND reseller_id = ? AND invoice_id = ?
        FOR UPDATE`,
      [orgId, terms.resellerId, id],
    );
    const row = again && again[0];
    if (!row) throw err;
    if (standingRow(row)) return { action: 'none', commissionId: Number(row.id), resellerId: terms.resellerId };
    return (await restore(exec, orgId, invoice, row, terms)) || NONE;
  }
  const withId = { ...terms, commissionId: insertId };
  const entryId = await earn(exec, orgId, invoice, withId, 'commission');
  return { action: 'earned', commissionId: insertId, resellerId: terms.resellerId, amount: terms.amount, entryId };
}

/**
 * syncResellerCommission for a caller that knows only the invoice id (the
 * paid-status recomputes): the invoice's own organization is read first.
 */
async function syncCommissionByInvoice(exec, invoiceId, orgId) {
  if (orgId !== undefined) return syncResellerCommission(exec, invoiceId, orgId);
  const rows = rowsOf(await exec(
    `/* org-scoped by: the invoice's own organization, read to scope the sync */
     /* includes deleted rows: the sync itself decides what a deleted invoice earns */
     SELECT organization_id FROM invoices WHERE id = ?`,
    [invoiceId],
  ));
  if (!rows[0]) return NONE;
  return syncResellerCommission(exec, invoiceId, rows[0].organization_id ?? null);
}

/**
 * Sync after a paid-status UPDATE: only when that UPDATE changed the row
 * (`result` is what exec returned for it).
 */
async function syncAfterStatusWrite(exec, invoiceId, result, orgId) {
  if (Number(headerOf(result).affectedRows) !== 1) return NONE;
  return syncCommissionByInvoice(exec, invoiceId, orgId);
}

/**
 * For a caller with no transaction of its own (a void or a SAT cancellation,
 * which run as separate statements): one transaction just for the sync.
 */
async function syncResellerCommissionInOwnTransaction(invoiceId, orgId) {
  requireOrgId(orgId, 'resellerCommissionService.syncResellerCommissionInOwnTransaction');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await syncResellerCommission(conn.execute.bind(conn), invoiceId, orgId);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
}

/** The same, logging instead of throwing: the invoice change it follows is already committed. */
async function syncResellerCommissionBestEffort(invoiceId, orgId) {
  try {
    return await syncResellerCommissionInOwnTransaction(invoiceId, orgId);
  } catch (err) {
    logger.error({ err, invoiceId, orgId }, 'Reseller commission sync failed; the phase 5 gap sweep must reconcile this invoice');
    return NONE;
  }
}

/**
 * The go-live instant of the engine for an organization (a Date), or null:
 * the reseller_commissions_since setting (migration 007), else the
 * organization's creation, as commissionTerms reads it.
 */
async function commissionsSince(orgId, exec = db.query.bind(db)) {
  requireOrgId(orgId, 'resellerCommissionService.commissionsSince');
  const [rows] = await exec(
    `SELECT o.created_at, s.setting_value AS commissions_since
       FROM organizations o
       LEFT JOIN organization_settings s ON s.organization_id = o.id AND s.setting_key = ?
      WHERE o.id = ? AND o.deleted_at IS NULL`,
    [COMMISSIONS_SINCE_KEY, orgId],
  );
  const org = rows && rows[0];
  if (!org) return null;
  const ms = instant(org.commissions_since) ?? instant(org.created_at);
  return ms === null ? null : new Date(ms);
}

// The most invoices one sweep reconciles in each direction; the rest wait for
// the next sweep (it reports truncated).
const SWEEP_LIMIT = 2000;

/**
 * The commission gap sweep (phase 5): reconcile a top-level reseller's
 * commissions with its subtree's invoices, for the invoice changes whose sync
 * did not run or failed (a void or SAT cancellation syncs best-effort, after
 * its own statements). Two set-based reads find the candidates:
 *
 *   (a) a paid, live invoice of a client of the reseller or one of its
 *       sub-resellers, paid at or after the go-live point, without a
 *       standing commission;
 *   (b) a standing commission of the reseller whose invoice is no longer
 *       paid, or is deleted.
 *
 * Each candidate is synced in its own short transaction
 * (syncResellerCommissionInOwnTransaction), never in one long one. A candidate
 * of (a) that earns nothing by the rules (a foreign currency, a rate of 0)
 * comes back on every sweep and counts as unchanged.
 *
 * @returns {Promise<{earned: number, restored: number, reversed: number, unchanged: number, failed: number, truncated: boolean}>}
 */
async function sweepCommissionGaps(orgId, topResellerId) {
  requireOrgId(orgId, 'resellerCommissionService.sweepCommissionGaps');
  const out = { earned: 0, restored: 0, reversed: 0, unchanged: 0, failed: 0, truncated: false };
  const rootId = Number(topResellerId);
  if (orgId === null || !Number.isInteger(rootId) || rootId < 1) return out;

  const [subtree] = await db.query(
    `SELECT id FROM resellers
      WHERE organization_id = ? AND deleted_at IS NULL AND (id = ? OR parent_id = ?)`,
    [orgId, rootId, rootId],
  );
  const resellerIds = (subtree || []).map((r) => Number(r.id));
  const since = await commissionsSince(orgId);

  let missing = [];
  if (resellerIds.length && since) {
    const [rows] = await db.query(
      `/* includes deleted rows: an archived client's paid invoices still earn its reseller's commission */
       SELECT i.id
         FROM invoices i
         JOIN clients c ON c.id = i.client_id AND c.organization_id = i.organization_id
        WHERE i.organization_id = ? AND i.status = 'paid' AND i.deleted_at IS NULL
          AND i.paid_at IS NOT NULL AND i.paid_at >= ?
          AND c.reseller_id IN (${inPlaceholders(resellerIds)})
          AND NOT EXISTS (
            SELECT 1 FROM reseller_commissions rc
             WHERE rc.organization_id = i.organization_id AND rc.invoice_id = i.id AND rc.reversed_at IS NULL
          )
        ORDER BY i.id
        LIMIT ${SWEEP_LIMIT + 1}`,
      [orgId, since, ...resellerIds],
    );
    missing = (rows || []).map((r) => Number(r.id));
  }
  const [staleRows] = await db.query(
    `/* includes deleted rows: a deleted invoice's standing commission is stale and must be reversed */
     SELECT DISTINCT rc.invoice_id
       FROM reseller_commissions rc
       JOIN invoices i ON i.id = rc.invoice_id AND i.organization_id = rc.organization_id
      WHERE rc.organization_id = ? AND rc.reseller_id = ? AND rc.reversed_at IS NULL
        AND (i.status <> 'paid' OR i.deleted_at IS NOT NULL)
      ORDER BY rc.invoice_id
      LIMIT ${SWEEP_LIMIT + 1}`,
    [orgId, rootId],
  );
  let stale = (staleRows || []).map((r) => Number(r.invoice_id));
  if (missing.length > SWEEP_LIMIT || stale.length > SWEEP_LIMIT) out.truncated = true;
  missing = missing.slice(0, SWEEP_LIMIT);
  stale = stale.slice(0, SWEEP_LIMIT);

  for (const invoiceId of [...stale, ...missing]) {
    try {
      const result = await syncResellerCommissionInOwnTransaction(invoiceId, orgId);
      if (result.action === 'earned') out.earned += 1;
      else if (result.action === 'restored') out.restored += 1;
      else if (result.action === 'reversed') out.reversed += 1;
      else out.unchanged += 1;
    } catch (err) {
      out.failed += 1;
      logger.error({ err, invoiceId, orgId }, 'Reseller commission gap sweep could not reconcile an invoice');
    }
  }
  if (out.earned || out.restored || out.reversed || out.failed) {
    logger.info({ orgId, resellerId: rootId, ...out }, 'Reseller commission gap sweep reconciled invoices');
  }
  return out;
}

function businessMonthStartUtc() {
  return businessDayStartUtc(`${businessToday().slice(0, 7)}-01`);
}

/**
 * The commission a top-level reseller earned this business month and still
 * keeps: SUM(commission_amount) of its standing rows earned since the first
 * day of the month (organization time zone).
 */
async function commissionThisMonth(orgId, resellerId, exec = db.query.bind(db)) {
  requireOrgId(orgId, 'resellerCommissionService.commissionThisMonth');
  const [rows] = await exec(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total
       FROM reseller_commissions
      WHERE organization_id = ? AND reseller_id = ? AND status = 'earned' AND reversed_at IS NULL
        AND earned_at >= ?`,
    [orgId, resellerId, businessMonthStartUtc()],
  );
  return money.round(rows && rows[0] ? rows[0].total : 0);
}

function commissionRow(r) {
  const num = (v) => (v === null || v === undefined ? null : money.round(v));
  return {
    id: Number(r.id),
    reseller_id: Number(r.reseller_id),
    invoice_id: Number(r.invoice_id),
    invoice_number: r.invoice_number ?? null,
    client_id: Number(r.client_id),
    client_name: r.client_name ?? null,
    commission_rate: num(r.commission_rate),
    base_amount: num(r.base_amount),
    invoice_total: num(r.invoice_total),
    commission_amount: num(r.commission_amount),
    currency: r.currency,
    status: r.reversed_at || r.status === 'reversed' ? 'reversed' : 'earned',
    earned_at: r.earned_at ?? null,
    reversed_at: r.reversed_at ?? null,
    created_at: r.created_at ?? null,
  };
}

/**
 * A page of a top-level reseller's commissions, newest first, with the
 * client's name and the invoice number: { rows, total, summary } where
 * summary = { earned, reversed, earned_this_month }.
 */
async function listCommissions(orgId, resellerId, { status = null, limit, offset }) {
  requireOrgId(orgId, 'resellerCommissionService.listCommissions');
  const where = ['rc.organization_id = ?', 'rc.reseller_id = ?'];
  const params = [orgId, resellerId];
  if (status === 'earned') where.push('rc.reversed_at IS NULL');
  if (status === 'reversed') where.push('rc.reversed_at IS NOT NULL');
  const [rows] = await db.query(
    `/* includes deleted rows: a commission keeps naming its client and invoice */
     SELECT rc.id, rc.reseller_id, rc.invoice_id, rc.client_id, rc.commission_rate, rc.base_amount, rc.invoice_total,
            rc.commission_amount, rc.currency, rc.status, rc.earned_at, rc.reversed_at, rc.created_at,
            c.name AS client_name, i.invoice_number
       FROM reseller_commissions rc
       LEFT JOIN clients c ON c.id = rc.client_id AND c.organization_id = rc.organization_id
       LEFT JOIN invoices i ON i.id = rc.invoice_id AND i.organization_id = rc.organization_id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(rc.earned_at, rc.created_at) DESC, rc.id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM reseller_commissions rc WHERE ${where.join(' AND ')}`,
    params,
  );
  const [[sums]] = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN reversed_at IS NULL THEN commission_amount END), 0) AS earned,
            COALESCE(SUM(CASE WHEN reversed_at IS NOT NULL THEN commission_amount END), 0) AS reversed
       FROM reseller_commissions
      WHERE organization_id = ? AND reseller_id = ?`,
    [orgId, resellerId],
  );
  const earnedThisMonth = await commissionThisMonth(orgId, resellerId);
  return {
    rows: (rows || []).map(commissionRow),
    total: Number(count?.total) || 0,
    summary: {
      earned: money.round(sums?.earned || 0),
      reversed: money.round(sums?.reversed || 0),
      earned_this_month: earnedThisMonth,
    },
  };
}

module.exports = {
  COMMISSIONS_SINCE_KEY,
  commissionAmount,
  topLevelReseller,
  commissionResellerForClient,
  syncResellerCommission,
  syncCommissionByInvoice,
  syncAfterStatusWrite,
  syncResellerCommissionInOwnTransaction,
  syncResellerCommissionBestEffort,
  commissionsSince,
  sweepCommissionGaps,
  SWEEP_LIMIT,
  commissionThisMonth,
  listCommissions,
  commissionRow,
  businessMonthStartUtc,
};
