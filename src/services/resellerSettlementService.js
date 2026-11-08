// =============================================================================
// VigaBSS 5.0 — Reseller statements and settlement (reseller program, phase 5)
// =============================================================================
// A statement (estado de cuenta, reseller_settlements, migration 008) closes a
// period of a TOP-LEVEL reseller's cash ledger (resellerLedgerService). Its
// figures are always rebuilt from the ledger:
//
//   opening_balance = SUM(amount) of the entries created before the period
//   total_<type>    = SUM(amount) of the period's entries of that entry type
//   closing_balance = opening_balance + every total_<type>
//
// Periods are business days of the organization time zone, half-open on
// instants: [start of period_start, start of the day after period_end). A
// period must have ended before it is generated. Ledger lines are always
// created "now", so a line posted later (a late commission reversal) lands
// in a later period and an approved statement can never change; approving
// still recomputes, inside its transaction, as a guard.
//
//   generate    the commission gap sweep runs first, so the statement carries
//               every commission the period's invoices earned; then a draft
//               with the figures. Statements of one reseller never overlap
//               (void ones excepted).
//   regenerate  a draft only: sweep and recompute
//   discard     a draft only: status void, kept for the audit trail
//   approve     a draft only: recompute, freeze (reseller_settlements.approve)
//   settle      an approved one: record the transfer that squares the closing
//               balance with a bank reference. closing > 0 (the reseller owed
//               the ISP): a deposit line of -closing; closing < 0 (the ISP
//               owed the reseller): a payout line of +|closing|; 0: nothing.
//               The usual caps hold against the CURRENT balance (a deposit at
//               most the cash on hand, a payout at most what the ISP owes):
//               when that money already moved (bags, deposits, payouts since),
//               settling refuses (SETTLEMENT_EXCEEDS_BALANCE) and record_only
//               marks it settled without a line.
//
// Lock order: the reseller row FOR UPDATE (as every writer of its money),
// then the statement row.
// =============================================================================

const db = require('../config/database');
const money = require('../utils/money');
const { requireOrgId } = require('../utils/requireOrgId');
const { AppError, NotFoundError, ValidationError, ConflictError } = require('../utils/errors');
const { businessToday, addDays, startOfMonth, businessDayStartUtc } = require('../utils/businessDate');
const ledger = require('./resellerLedgerService');
const commissions = require('./resellerCommissionService');

const STATUSES = ['draft', 'approved', 'settled', 'void'];
const TOTAL_TYPES = ledger.ENTRY_TYPES;
const MAX_PERIOD_DAYS = 366;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const toMoney = (v) => money.round(v === null || v === undefined || v === '' ? 0 : v);
const idOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function coded(err, code) {
  err.code = code;
  return err;
}

function ymdOf(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    // A DATE column read by mysql2 with timezone '+00:00' is midnight UTC.
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function isRealDate(ymd) {
  if (!YMD.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** The previous business calendar month: { period_start, period_end }. */
function defaultPeriod(today = businessToday()) {
  const end = addDays(startOfMonth(today), -1);
  return { period_start: startOfMonth(end), period_end: end };
}

/** Validate a period; throws 422 with a code. */
function assertPeriod(periodStart, periodEnd, today = businessToday()) {
  if (!isRealDate(periodStart) || !isRealDate(periodEnd)) {
    throw coded(new ValidationError('period_start and period_end must be dates (YYYY-MM-DD)'), 'VALIDATION_ERROR');
  }
  if (periodStart > periodEnd) {
    throw coded(new ValidationError('period_start must be on or before period_end'), 'PERIOD_INVALID');
  }
  if (periodEnd >= today) {
    throw coded(new ValidationError('A statement covers a period that has ended: period_end must be before today'), 'PERIOD_NOT_ENDED');
  }
  const days = (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw coded(new ValidationError(`A statement covers at most ${MAX_PERIOD_DAYS} days`), 'PERIOD_TOO_LONG');
  }
}

/** [startUtc, endUtc) of a period of business days. */
function periodBounds(periodStart, periodEnd) {
  return {
    startUtc: businessDayStartUtc(periodStart),
    endUtc: businessDayStartUtc(addDays(periodEnd, 1)),
  };
}

/**
 * The figures of a period, from the ledger, on `exec`:
 * { opening_balance, totals: {type: amount}, closing_balance, entry_count }.
 */
async function computeFigures(exec, orgId, resellerId, periodStart, periodEnd) {
  requireOrgId(orgId, 'resellerSettlementService.computeFigures');
  const { startUtc, endUtc } = periodBounds(periodStart, periodEnd);
  const [openRows] = await exec(
    `SELECT COALESCE(SUM(amount), 0) AS opening
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ? AND created_at < ?`,
    [orgId, resellerId, startUtc],
  );
  const [typeRows] = await exec(
    `SELECT entry_type, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ? AND created_at >= ? AND created_at < ?
      GROUP BY entry_type`,
    [orgId, resellerId, startUtc, endUtc],
  );
  const totals = Object.fromEntries(TOTAL_TYPES.map((t) => [t, 0]));
  let count = 0;
  for (const r of typeRows || []) {
    if (!Object.prototype.hasOwnProperty.call(totals, r.entry_type)) {
      // A type this service does not know would silently fall out of the
      // closing balance: refuse instead.
      throw new Error(`Reseller ledger entry type without a statement total: ${r.entry_type}`);
    }
    totals[r.entry_type] = toMoney(r.total);
    count += Number(r.n) || 0;
  }
  const opening = toMoney(openRows && openRows[0] ? openRows[0].opening : 0);
  const closing = TOTAL_TYPES.reduce((sum, t) => money.add(sum, totals[t]), opening);
  return { opening_balance: opening, totals, closing_balance: toMoney(closing), entry_count: count };
}

const sameFigures = (row, figures) => (
  money.toCents(row.opening_balance) === money.toCents(figures.opening_balance)
  && money.toCents(row.closing_balance) === money.toCents(figures.closing_balance)
  && Number(row.entry_count) === figures.entry_count
  && TOTAL_TYPES.every((t) => money.toCents(row[`total_${t}`]) === money.toCents(figures.totals[t]))
);

function figureColumns(figures) {
  const cols = {
    opening_balance: figures.opening_balance,
    closing_balance: figures.closing_balance,
    entry_count: figures.entry_count,
  };
  for (const t of TOTAL_TYPES) cols[`total_${t}`] = figures.totals[t];
  return cols;
}

/** The API shape of a statement row. */
function statementRow(r) {
  const totals = Object.fromEntries(TOTAL_TYPES.map((t) => [t, toMoney(r[`total_${t}`])]));
  return {
    id: Number(r.id),
    reseller_id: Number(r.reseller_id),
    reseller_name: r.reseller_name ?? null,
    period_start: ymdOf(r.period_start),
    period_end: ymdOf(r.period_end),
    currency: r.currency,
    opening_balance: toMoney(r.opening_balance),
    totals,
    closing_balance: toMoney(r.closing_balance),
    entry_count: Number(r.entry_count) || 0,
    sweep_earned: Number(r.sweep_earned) || 0,
    sweep_reversed: Number(r.sweep_reversed) || 0,
    status: r.status,
    generated_by: idOrNull(r.generated_by),
    generated_at: r.generated_at ?? null,
    approved_by: idOrNull(r.approved_by),
    approved_at: r.approved_at ?? null,
    settled_by: idOrNull(r.settled_by),
    settled_at: r.settled_at ?? null,
    bank_ref: r.bank_ref ?? null,
    settlement_entry_id: idOrNull(r.settlement_entry_id),
    voided_at: r.voided_at ?? null,
    notes: r.notes ?? null,
  };
}

const SELECT_STATEMENT = `
  SELECT s.*, r.name AS reseller_name
    FROM reseller_settlements s
    JOIN resellers r ON r.id = s.reseller_id AND r.organization_id = s.organization_id`;

/** One statement of a reseller, or a 404. `forUpdate` locks it on `exec`. */
async function loadStatement(exec, orgId, resellerId, statementId, { forUpdate = false } = {}) {
  requireOrgId(orgId, 'resellerSettlementService.loadStatement');
  const [rows] = await exec(
    `${forUpdate ? 'SELECT s.* FROM reseller_settlements s' : SELECT_STATEMENT}
      WHERE s.id = ? AND s.organization_id = ? AND s.reseller_id = ?
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [statementId, orgId, resellerId],
  );
  if (!rows || !rows[0]) throw new NotFoundError('Statement');
  return rows[0];
}

/** The live, top-level reseller row, locked FOR UPDATE on `exec`; 404 / 422. */
async function lockTopLevel(exec, orgId, resellerId) {
  const reseller = await ledger.lockReseller(exec, orgId, resellerId);
  if (!reseller) throw new NotFoundError('Reseller');
  if (reseller.parent_id !== null && reseller.parent_id !== undefined) {
    throw coded(
      new ValidationError('Statements close the ledger of a top-level reseller; a sub-reseller has none (see its parent)'),
      'NOT_TOP_LEVEL',
    );
  }
  return reseller;
}

async function inTransaction(fn) {
  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  try {
    await conn.beginTransaction();
    const out = await fn(exec);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
}

async function reload(orgId, resellerId, statementId) {
  return statementRow(await loadStatement(db.query.bind(db), orgId, resellerId, statementId));
}

/**
 * Generate a draft statement. Runs the commission gap sweep first.
 * @returns {Promise<{statement: object, sweep: object}>}
 */
async function generate({ orgId, resellerId, periodStart, periodEnd, notes = null, userId }) {
  requireOrgId(orgId, 'resellerSettlementService.generate');
  const period = periodStart || periodEnd
    ? { period_start: periodStart, period_end: periodEnd }
    : defaultPeriod();
  assertPeriod(period.period_start, period.period_end);

  // Validate the reseller before the sweep does any work.
  await inTransaction((exec) => lockTopLevel(exec, orgId, resellerId));
  const sweep = await commissions.sweepCommissionGaps(orgId, resellerId);
  const currency = await require('../models/Organization').getCurrency(orgId);

  const id = await inTransaction(async (exec) => {
    await lockTopLevel(exec, orgId, resellerId);
    const [overlap] = await exec(
      `SELECT id, period_start, period_end, status FROM reseller_settlements
        WHERE organization_id = ? AND reseller_id = ? AND status <> 'void'
          AND period_start <= ? AND period_end >= ?
        LIMIT 1`,
      [orgId, resellerId, period.period_end, period.period_start],
    );
    if (overlap && overlap[0]) {
      const o = overlap[0];
      throw coded(
        new ConflictError(`Statement #${o.id} (${ymdOf(o.period_start)} to ${ymdOf(o.period_end)}, ${o.status}) already covers part of this period`),
        'SETTLEMENT_PERIOD_OVERLAP',
      );
    }
    const figures = await computeFigures(exec, orgId, resellerId, period.period_start, period.period_end);
    const cols = figureColumns(figures);
    const names = Object.keys(cols);
    const [res] = await exec(
      `INSERT INTO reseller_settlements
         (organization_id, reseller_id, period_start, period_end, currency, ${names.join(', ')},
          sweep_earned, sweep_reversed, status, generated_by, notes)
       VALUES (?, ?, ?, ?, ?, ${names.map(() => '?').join(', ')}, ?, ?, 'draft', ?, ?)`,
      [orgId, resellerId, period.period_start, period.period_end, currency, ...names.map((n) => cols[n]),
        sweep.earned + sweep.restored, sweep.reversed, userId ?? null, notes],
    );
    return Number(res.insertId);
  });
  return { statement: await reload(orgId, resellerId, id), sweep };
}

/** Sweep and recompute a draft. */
async function regenerate({ orgId, resellerId, statementId, userId }) {
  requireOrgId(orgId, 'resellerSettlementService.regenerate');
  const before = await loadStatement(db.query.bind(db), orgId, resellerId, statementId);
  if (before.status !== 'draft') {
    throw coded(new ConflictError(`Only a draft can be regenerated (this one is ${before.status})`), 'SETTLEMENT_NOT_DRAFT');
  }
  const sweep = await commissions.sweepCommissionGaps(orgId, resellerId);
  await inTransaction(async (exec) => {
    await lockTopLevel(exec, orgId, resellerId);
    const row = await loadStatement(exec, orgId, resellerId, statementId, { forUpdate: true });
    if (row.status !== 'draft') {
      throw coded(new ConflictError(`Only a draft can be regenerated (this one is ${row.status})`), 'SETTLEMENT_NOT_DRAFT');
    }
    const figures = await computeFigures(exec, orgId, resellerId, ymdOf(row.period_start), ymdOf(row.period_end));
    const cols = figureColumns(figures);
    const names = Object.keys(cols);
    await exec(
      `UPDATE reseller_settlements
          SET ${names.map((n) => `${n} = ?`).join(', ')},
              sweep_earned = ?, sweep_reversed = ?, generated_by = ?, generated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      [...names.map((n) => cols[n]), sweep.earned + sweep.restored, sweep.reversed, userId ?? null, statementId, orgId],
    );
  });
  return { statement: await reload(orgId, resellerId, statementId), sweep };
}

/** Discard a draft (status void). */
async function discard({ orgId, resellerId, statementId, userId }) {
  requireOrgId(orgId, 'resellerSettlementService.discard');
  await inTransaction(async (exec) => {
    await lockTopLevel(exec, orgId, resellerId);
    const row = await loadStatement(exec, orgId, resellerId, statementId, { forUpdate: true });
    if (row.status !== 'draft') {
      throw coded(new ConflictError(`Only a draft can be discarded (this one is ${row.status})`), 'SETTLEMENT_NOT_DRAFT');
    }
    await exec(
      `UPDATE reseller_settlements SET status = 'void', voided_by = ?, voided_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      [userId ?? null, statementId, orgId],
    );
  });
  return reload(orgId, resellerId, statementId);
}

/**
 * Approve a draft: recompute and freeze. `recomputed` is true when the
 * figures differed from the draft's (they should not: the period is closed).
 */
async function approve({ orgId, resellerId, statementId, userId }) {
  requireOrgId(orgId, 'resellerSettlementService.approve');
  const recomputed = await inTransaction(async (exec) => {
    await lockTopLevel(exec, orgId, resellerId);
    const row = await loadStatement(exec, orgId, resellerId, statementId, { forUpdate: true });
    if (row.status !== 'draft') {
      throw coded(new ConflictError(`Only a draft can be approved (this one is ${row.status})`), 'SETTLEMENT_NOT_DRAFT');
    }
    const figures = await computeFigures(exec, orgId, resellerId, ymdOf(row.period_start), ymdOf(row.period_end));
    const changed = !sameFigures(row, figures);
    const cols = changed ? figureColumns(figures) : {};
    const names = Object.keys(cols);
    await exec(
      `UPDATE reseller_settlements
          SET ${names.map((n) => `${n} = ?, `).join('')}status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ? AND organization_id = ? AND status = 'draft'`,
      [...names.map((n) => cols[n]), userId ?? null, statementId, orgId],
    );
    return changed;
  });
  return { statement: await reload(orgId, resellerId, statementId), recomputed };
}

/**
 * Settle an approved statement with a bank reference; see the header.
 * @returns {Promise<{statement: object, entry_id: number|null}>}
 */
async function settle({ orgId, resellerId, statementId, bankRef, recordOnly = false, userId }) {
  requireOrgId(orgId, 'resellerSettlementService.settle');
  const ref = typeof bankRef === 'string' ? bankRef.trim() : '';
  if (!ref) throw new ValidationError('bank_ref is required: the bank or transfer reference of the settlement');
  if (ref.length > 100) throw new ValidationError('bank_ref is at most 100 characters');

  const entryId = await inTransaction(async (exec) => {
    const reseller = await lockTopLevel(exec, orgId, resellerId);
    const row = await loadStatement(exec, orgId, resellerId, statementId, { forUpdate: true });
    if (row.status !== 'approved') {
      throw coded(new ConflictError(`Only an approved statement can be settled (this one is ${row.status})`), 'SETTLEMENT_NOT_APPROVED');
    }
    const closing = toMoney(row.closing_balance);
    let posted = null;
    if (!recordOnly && money.toCents(closing) !== 0) {
      const position = await ledger.summaryFor(orgId, reseller.id, { exec, reseller });
      const note = `Liquidación del estado de cuenta #${row.id} (${ymdOf(row.period_start)} a ${ymdOf(row.period_end)}), ref. ${ref}`;
      if (closing > 0) {
        if (money.toCents(closing) > money.toCents(position.cash_on_hand)) {
          throw coded(new AppError(
            `The statement closed with ${closing.toFixed(2)} owed by the reseller, but it now holds ${position.cash_on_hand.toFixed(2)}: that money already moved. Settle it as record only.`,
            409, 'SETTLEMENT_EXCEEDS_BALANCE',
          ), 'SETTLEMENT_EXCEEDS_BALANCE');
        }
        posted = await ledger.appendEntry(exec, {
          orgId, resellerId: reseller.id, entryType: 'deposit', amount: -closing, currency: row.currency, note, createdBy: userId,
        });
      } else {
        const owed = Math.max(0, -position.balance);
        if (money.toCents(-closing) > money.toCents(owed)) {
          throw coded(new AppError(
            `The statement closed with ${(-closing).toFixed(2)} owed to the reseller, but the ISP now owes it ${owed.toFixed(2)}: that money already moved. Settle it as record only.`,
            409, 'SETTLEMENT_EXCEEDS_BALANCE',
          ), 'SETTLEMENT_EXCEEDS_BALANCE');
        }
        posted = await ledger.appendEntry(exec, {
          orgId, resellerId: reseller.id, entryType: 'payout', amount: -closing, currency: row.currency, note, createdBy: userId,
        });
      }
    }
    await exec(
      `UPDATE reseller_settlements
          SET status = 'settled', settled_by = ?, settled_at = CURRENT_TIMESTAMP, bank_ref = ?, settlement_entry_id = ?
        WHERE id = ? AND organization_id = ? AND status = 'approved'`,
      [userId ?? null, ref, posted, statementId, orgId],
    );
    return posted === null ? null : Number(posted);
  });
  return { statement: await reload(orgId, resellerId, statementId), entry_id: entryId };
}

/** A page of a reseller's statements, newest period first. */
async function list(orgId, resellerId, { statuses = null, limit, offset }) {
  requireOrgId(orgId, 'resellerSettlementService.list');
  const where = ['s.organization_id = ?', 's.reseller_id = ?'];
  const params = [orgId, resellerId];
  if (statuses && statuses.length) {
    where.push(`s.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const [rows] = await db.query(
    `${SELECT_STATEMENT}
      WHERE ${where.join(' AND ')}
      ORDER BY s.period_start DESC, s.id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM reseller_settlements s WHERE ${where.join(' AND ')}`,
    params,
  );
  return { rows: (rows || []).map(statementRow), total: Number(count?.total) || 0 };
}

/** One statement (API shape). */
async function get(orgId, resellerId, statementId) {
  return reload(orgId, resellerId, statementId);
}

/**
 * The ledger lines of a statement's period, oldest first, with invoice
 * numbers and bag serials: { rows, total }. `limit` null = every line.
 */
async function lines(orgId, statement, { limit = null, offset = 0 } = {}) {
  requireOrgId(orgId, 'resellerSettlementService.lines');
  const { startUtc, endUtc } = periodBounds(statement.period_start, statement.period_end);
  const page = limit === null ? '' : `LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
  const [rows] = await db.query(
    `SELECT id, entry_type, amount, currency, note, created_at, payment_id, cash_session_id, created_by, cash_bag_id,
            invoice_id, commission_id
       FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ? AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC, id ASC
      ${page}`,
    [orgId, statement.reseller_id, startUtc, endUtc],
  );
  await ledger.withBagSerials(orgId, rows);
  await ledger.withInvoiceNumbers(orgId, rows);
  const [[count]] = await db.query(
    `SELECT COUNT(*) AS total FROM reseller_ledger_entries
      WHERE organization_id = ? AND reseller_id = ? AND created_at >= ? AND created_at < ?`,
    [orgId, statement.reseller_id, startUtc, endUtc],
  );
  return { rows: (rows || []).map(ledger.entryRow), total: Number(count?.total) || 0 };
}

module.exports = {
  STATUSES,
  TOTAL_TYPES,
  MAX_PERIOD_DAYS,
  defaultPeriod,
  assertPeriod,
  periodBounds,
  computeFigures,
  statementRow,
  generate,
  regenerate,
  discard,
  approve,
  settle,
  list,
  get,
  lines,
};
