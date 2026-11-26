// =============================================================================
// VigaBSS 5.0 — Money tie-out
// =============================================================================
// Ties a month's collections to the bank. Three questions, each answered from
// the records that already hold the money:
//
//   1. What was collected, and how is it invoiced?  (payments, allocations,
//      CFDIs, General Public invoices)
//   2. Where is the cash?  It moves point -> bag -> safe -> bank, or
//      drawer -> pickup -> safe -> bank:
//        at points    reseller_ledger_entries: what each point still holds
//        in bags      cash_bags sealed and not yet received
//        in drawers   cash_reconciliation_sessions: the cash each cashier holds
//        in the safe  confirmed pickups + received bags + cash a point handed
//                     in + other cash in, less bank deposits and other cash
//                     out, since the first safe count, corrected by each count
//        in the bank  cash_safe_movements of kind 'deposit', per account
//   3. Does it add up?  For the month:
//        cash recorded = bank deposits + commissions kept + other cash out
//                        - other cash in + (in transit at the end - in transit
//                        at the start) - differences
//      The differences are listed by where they were recorded (a cashier's
//      count, a bag's count, a safe count, a correction on a point's ledger, a
//      payout to a point). What none of them explains is shown as unexplained
//      rather than hidden.
//
// Income is dated by the customer's payment, not by the deposit: cash taken on
// the 30th and deposited on the 3rd is the first month's income and is in
// transit at its end.
//
// The safe is tracked from its first count. Until then its balance is unknown
// (null) and the month cannot be closed on cash.
// =============================================================================

const db = require('../config/database');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { businessDayStartUtc, businessToday } = require('../utils/businessDate');
const { PUBLICO_EN_GENERAL_RFC } = require('../utils/satCatalogs');

const PURPOSES = ['client_invoices', 'general_public', 'any'];
const KINDS = ['count', 'deposit', 'other_in', 'other_out'];
// Days after which cash that has not moved on is listed for attention.
const BAG_MAX_DAYS = 3;
const SAFE_MAX_DAYS = 3;
const PICKUP_MAX_DAYS = 1;
// RESICO for individuals (régimen 626): the yearly income ceiling.
const RESICO_REGIMEN = '626';
const RESICO_LIMIT = 3500000;

const cents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;
const round2 = (v) => fromCents(cents(v));

function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new ValidationError('year must be a calendar year between 2000 and 2100');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new ValidationError('month must be a number between 1 and 12');
  const ymd = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const from = ymd(y, m);
  const to = m === 12 ? ymd(y + 1, 1) : ymd(y, m + 1);
  return { year: y, month: m, from, to, fromUtc: businessDayStartUtc(from), toUtc: businessDayStartUtc(to) };
}

// ---------------------------------------------------------------------------
// Where the cash is at a moment
// ---------------------------------------------------------------------------

/**
 * The count the safe is tracked from (the earliest one) and, up to `at`, the
 * sum of what every count corrected: counted less what the safe should have
 * held. Null when the safe had not been counted by then.
 *
 * A count is applied as a correction and not as a new starting point, so it
 * does not matter in which order a count and another movement of the same
 * second happened: timestamps are stored to the second.
 */
async function safeCounts(orgId, at) {
  const [[row]] = await db.query(
    `SELECT MIN(moved_at) AS since, COALESCE(SUM(amount - COALESCE(expected_amount, 0)), 0) AS corrections
       FROM cash_safe_movements
      WHERE organization_id = ? AND kind = 'count' AND moved_at < ? AND deleted_at IS NULL`,
    [orgId, at],
  );
  return row && row.since ? { since: row.since, corrections: Number(row.corrections) } : null;
}

/** Cash that reached or left the safe in [from, to), by source. */
async function safeFlows(orgId, from, to) {
  const [[pickups]] = await db.query(
    `SELECT COALESCE(SUM(k.amount), 0) AS total FROM cash_reconciliation_pickups k
      WHERE k.organization_id = ? AND k.status = 'confirmed' AND k.confirmed_at >= ? AND k.confirmed_at < ?`,
    [orgId, from, to],
  );
  const [[bags]] = await db.query(
    `SELECT COALESCE(SUM(b.counted_amount), 0) AS total FROM cash_bags b
      WHERE b.organization_id = ? AND b.status = 'received' AND b.received_at >= ? AND b.received_at < ?
        AND b.deleted_at IS NULL`,
    [orgId, from, to],
  );
  const [[handedIn]] = await db.query(
    `SELECT COALESCE(-SUM(e.amount), 0) AS total FROM reseller_ledger_entries e
      WHERE e.organization_id = ? AND e.entry_type = 'deposit' AND e.created_at >= ? AND e.created_at < ?`,
    [orgId, from, to],
  );
  const [moves] = await db.query(
    `SELECT kind, COALESCE(SUM(amount), 0) AS total FROM cash_safe_movements
      WHERE organization_id = ? AND kind <> 'count' AND moved_at >= ? AND moved_at < ? AND deleted_at IS NULL
      GROUP BY kind`,
    [orgId, from, to],
  );
  const byKind = Object.fromEntries((moves || []).map((r) => [r.kind, Number(r.total)]));
  return {
    pickups: round2(pickups.total), bags: round2(bags.total), handed_in: round2(handedIn.total),
    other_in: round2(byKind.other_in), deposits: round2(byKind.deposit), other_out: round2(byKind.other_out),
  };
}

/** What the safe should hold at `at`: every count's correction plus what moved since the first count. Null before it. */
async function safeBalance(orgId, at) {
  const counts = await safeCounts(orgId, at);
  if (!counts) return null;
  const f = await safeFlows(orgId, counts.since, at);
  return fromCents(cents(counts.corrections) + cents(f.pickups) + cents(f.bags) + cents(f.handed_in) + cents(f.other_in)
    - cents(f.deposits) - cents(f.other_out));
}

/** The cash each point holds at `at`: what points owe (positive balances) and what they are owed. */
async function pointsBalance(orgId, at) {
  const [rows] = await db.query(
    `SELECT e.reseller_id, SUM(e.amount) AS balance FROM reseller_ledger_entries e
      WHERE e.organization_id = ? AND e.created_at < ?
      GROUP BY e.reseller_id`,
    [orgId, at],
  );
  let held = 0;
  let owed = 0;
  for (const r of rows || []) {
    const c = cents(r.balance);
    if (c > 0) held += c; else owed += -c;
  }
  return { at_points: fromCents(held), owed_to_points: fromCents(owed) };
}

/** Declared cash in bags sealed before `at` and not received by then. */
async function bagsBalance(orgId, at) {
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(b.declared_amount), 0) AS total FROM cash_bags b
      WHERE b.organization_id = ? AND b.sealed_at IS NOT NULL AND b.sealed_at < ?
        AND (b.received_at IS NULL OR b.received_at >= ?)
        AND b.status NOT IN ('void', 'lost') AND b.deleted_at IS NULL`,
    [orgId, at, at],
  );
  return round2(row.total);
}

/**
 * The cash in staff drawers at `at`. A cashier that was open then holds its
 * opening count plus the cash it took, less the pickups its owner confirmed.
 * A payment an earlier cashier already counted is not taken again: timestamps
 * are stored to the second, so one recorded in the second this cashier opened
 * could otherwise be in both.
 * A cashier closed by then holds what was counted: closing is a count, not a
 * hand-in. Cashiers from before the opening count existed, and those of point
 * logins, are not drawers.
 */
async function drawersBalance(orgId, at) {
  const [rows] = await db.query(
    `SELECT s.id, s.agent_user_id, s.opened_at, s.closed_at, s.opening_total, s.counted_total,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
              WHERE p.organization_id = s.organization_id AND p.payment_method = 'cash'
                AND p.recorded_by = s.agent_user_id AND p.status = 'completed' AND p.deleted_at IS NULL
                AND p.reseller_id IS NULL
                AND p.created_at >= s.opened_at AND p.created_at < ?
                AND NOT EXISTS (
                  SELECT 1 FROM cash_reconciliation_session_payments counted
                   WHERE counted.payment_id = p.id AND counted.organization_id = p.organization_id
                     AND counted.session_id <> s.id
                )) AS collected,
            (SELECT COALESCE(SUM(k.amount), 0) FROM cash_reconciliation_pickups k
              WHERE k.organization_id = s.organization_id AND k.session_id = s.id
                AND k.status = 'confirmed' AND k.confirmed_at < ?) AS handed_in
       FROM cash_reconciliation_sessions s
      WHERE s.organization_id = ? AND s.deleted_at IS NULL AND s.opening_total IS NOT NULL
        AND s.opened_at < ?
        AND s.id = (SELECT MAX(l.id) FROM cash_reconciliation_sessions l
                     WHERE l.organization_id = s.organization_id AND l.agent_user_id = s.agent_user_id
                       AND l.deleted_at IS NULL AND l.opening_total IS NOT NULL AND l.opened_at < ?)
        AND NOT EXISTS (SELECT 1 FROM reseller_user_bindings rb
                         WHERE rb.user_id = s.agent_user_id AND rb.organization_id = s.organization_id)`,
    [at, at, orgId, at, at],
  );
  let total = 0;
  for (const s of rows || []) {
    const closedByThen = s.closed_at && new Date(s.closed_at) < at;
    total += closedByThen
      ? cents(s.counted_total)
      : cents(s.opening_total) + cents(s.collected) - cents(s.handed_in);
  }
  return fromCents(total);
}

/** Cash collected and not yet in the bank at `at`, by where it is. */
async function inTransit(orgId, at) {
  const [points, bags, drawers, safe] = await Promise.all([
    pointsBalance(orgId, at), bagsBalance(orgId, at), drawersBalance(orgId, at), safeBalance(orgId, at),
  ]);
  return {
    ...points, in_bags: bags, in_drawers: drawers, in_safe: safe,
    // What points are owed is not cash on its way, so it is not netted here.
    total: fromCents(cents(points.at_points) + cents(bags) + cents(drawers) + cents(safe)),
    // The cash position the month's sum is checked against.
    position: fromCents(cents(points.at_points) - cents(points.owed_to_points) + cents(bags) + cents(drawers) + cents(safe)),
  };
}

// ---------------------------------------------------------------------------
// What was collected, and how it is invoiced
// ---------------------------------------------------------------------------

async function collected(orgId, range) {
  const [rows] = await db.query(
    `SELECT p.payment_method, (p.reseller_id IS NOT NULL) AS at_point, COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS total
       FROM payments p
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.payment_date >= ? AND p.payment_date < ?
      GROUP BY p.payment_method, (p.reseller_id IS NOT NULL)`,
    [orgId, range.from, range.to],
  );
  const methods = new Map();
  let total = 0;
  let cash = 0;
  let cashPoints = 0;
  let count = 0;
  for (const r of rows || []) {
    const c = cents(r.total);
    total += c;
    count += Number(r.n);
    methods.set(r.payment_method, (methods.get(r.payment_method) || 0) + c);
    if (r.payment_method === 'cash') {
      cash += c;
      if (Number(r.at_point)) cashPoints += c;
    }
  }
  return {
    count, total: fromCents(total), cash: fromCents(cash), cash_staff: fromCents(cash - cashPoints),
    cash_points: fromCents(cashPoints), non_cash: fromCents(total - cash),
    by_method: [...methods].map(([method, c]) => ({ method, total: fromCents(c) })).sort((a, b) => b.total - a.total),
  };
}

/**
 * The month's collected money by how it is invoiced. Each allocation is
 * classed by its invoice:
 *   client_cfdi             the invoice has a CFDI in the client's RFC
 *   general_public_stamped  it is in a stamped General Public invoice, or has
 *                           its own CFDI to the generic RFC
 *   general_public_pending  paid, with no CFDI yet: it belongs in the
 *                           period's General Public invoice
 *   unpaid_no_cfdi          a part payment on an invoice with no CFDI
 * Money not on any invoice is credit.
 */
async function fiscalSplit(orgId, range, totals) {
  const liveCfdi = "cd.organization_id = i.organization_id AND cd.invoice_id = i.id AND cd.tipo_comprobante = 'I' AND cd.sat_status IN ('vigente', 'cancel_pending')";
  const [rows] = await db.query(
    `SELECT (p.payment_method = 'cash') AS is_cash,
            CASE
              WHEN EXISTS (SELECT 1 FROM cfdi_documents cd WHERE ${liveCfdi} AND cd.receptor_rfc <> ?) THEN 'client_cfdi'
              WHEN EXISTS (SELECT 1 FROM cfdi_documents cd WHERE ${liveCfdi} AND cd.receptor_rfc = ?)
                OR EXISTS (SELECT 1 FROM factura_publica_invoice_items fi
                             JOIN factura_publica_invoices f ON f.id = fi.factura_publica_invoice_id
                              AND f.organization_id = i.organization_id AND f.status = 'stamped'
                            WHERE fi.invoice_id = i.id) THEN 'general_public_stamped'
              WHEN i.status = 'paid' THEN 'general_public_pending'
              ELSE 'unpaid_no_cfdi'
            END AS class,
            COALESCE(SUM(pa.amount), 0) AS total
       FROM payments p
       JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.deleted_at IS NULL
       JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = p.organization_id AND i.deleted_at IS NULL
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.payment_date >= ? AND p.payment_date < ?
      GROUP BY is_cash, class`,
    [PUBLICO_EN_GENERAL_RFC, PUBLICO_EN_GENERAL_RFC, orgId, range.from, range.to],
  );
  const all = { client_cfdi: 0, general_public_stamped: 0, general_public_pending: 0, unpaid_no_cfdi: 0 };
  const cash = { ...all };
  for (const r of rows || []) {
    all[r.class] += cents(r.total);
    if (Number(r.is_cash)) cash[r.class] += cents(r.total);
  }
  const sum = (o) => Object.values(o).reduce((n, c) => n + c, 0);
  const shape = (o, whole) => ({
    client_cfdi: fromCents(o.client_cfdi),
    general_public_stamped: fromCents(o.general_public_stamped),
    general_public_pending: fromCents(o.general_public_pending),
    unpaid_no_cfdi: fromCents(o.unpaid_no_cfdi),
    credit: fromCents(cents(whole) - sum(o)),
    // Everything that is not in a client's RFC ends in a General Public invoice.
    general_public: fromCents(cents(whole) - o.client_cfdi),
  });
  return { ...shape(all, totals.total), cash: shape(cash, totals.cash) };
}

// ---------------------------------------------------------------------------
// The month's cash sum
// ---------------------------------------------------------------------------

async function cashRecorded(orgId, from, to) {
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p
      WHERE p.organization_id = ? AND p.payment_method = 'cash' AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.created_at >= ? AND p.created_at < ?`,
    [orgId, from, to],
  );
  return round2(row.total);
}

/** The differences recorded in [from, to): positive = more cash than expected. */
async function recordedDifferences(orgId, from, to) {
  const [[closing]] = await db.query(
    `SELECT COALESCE(SUM(s.variance), 0) AS total FROM cash_reconciliation_sessions s
      WHERE s.organization_id = ? AND s.deleted_at IS NULL AND s.opening_total IS NOT NULL
        AND s.closed_at >= ? AND s.closed_at < ?`,
    [orgId, from, to],
  );
  const [[opening]] = await db.query(
    `SELECT COALESCE(SUM(s.opening_total - COALESCE(s.opening_expected, 0)), 0) AS total
       FROM cash_reconciliation_sessions s
      WHERE s.organization_id = ? AND s.deleted_at IS NULL AND s.opening_total IS NOT NULL
        AND s.opened_at >= ? AND s.opened_at < ?
        AND NOT EXISTS (SELECT 1 FROM reseller_user_bindings rb
                         WHERE rb.user_id = s.agent_user_id AND rb.organization_id = s.organization_id)`,
    [orgId, from, to],
  );
  const [[bags]] = await db.query(
    `SELECT COALESCE(SUM(b.counted_amount - b.declared_amount), 0) AS total FROM cash_bags b
      WHERE b.organization_id = ? AND b.status = 'received' AND b.received_at >= ? AND b.received_at < ?
        AND b.deleted_at IS NULL`,
    [orgId, from, to],
  );
  const [[counts]] = await db.query(
    `SELECT COALESCE(SUM(amount - COALESCE(expected_amount, 0)), 0) AS total FROM cash_safe_movements
      WHERE organization_id = ? AND kind = 'count' AND moved_at >= ? AND moved_at < ? AND deleted_at IS NULL`,
    [orgId, from, to],
  );
  const [ledger] = await db.query(
    `SELECT e.entry_type, COALESCE(SUM(e.amount), 0) AS total FROM reseller_ledger_entries e
      WHERE e.organization_id = ? AND e.entry_type IN ('adjustment', 'payout') AND e.created_at >= ? AND e.created_at < ?
      GROUP BY e.entry_type`,
    [orgId, from, to],
  );
  const byType = Object.fromEntries((ledger || []).map((r) => [r.entry_type, Number(r.total)]));
  return {
    cashier_counts: fromCents(cents(closing.total) + cents(opening.total)),
    bag_counts: round2(bags.total),
    safe_counts: round2(counts.total),
    point_adjustments: round2(byType.adjustment),
    point_payouts: round2(byType.payout),
  };
}

/** Commissions and collection fees the points kept from the cash in [from, to), net of reversals. */
async function commissionsKept(orgId, from, to) {
  const [[row]] = await db.query(
    `SELECT COALESCE(-SUM(e.amount), 0) AS total FROM reseller_ledger_entries e
      WHERE e.organization_id = ?
        AND e.entry_type IN ('commission', 'commission_reversal', 'collection_fee', 'collection_fee_reversal')
        AND e.created_at >= ? AND e.created_at < ?`,
    [orgId, from, to],
  );
  return round2(row.total);
}

// ---------------------------------------------------------------------------
// Bank accounts and the safe
// ---------------------------------------------------------------------------

async function listBankAccounts(orgId) {
  const [rows] = await db.query(
    `SELECT id, name, bank_name, account_hint, purpose, status, created_at FROM bank_accounts
      WHERE organization_id = ? AND deleted_at IS NULL ORDER BY status, name, id`,
    [orgId],
  );
  return rows;
}

async function bankAccountOr404(orgId, id) {
  const [rows] = await db.query(
    'SELECT id, name, bank_name, account_hint, purpose, status FROM bank_accounts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  if (!rows[0]) throw new NotFoundError('Bank account');
  return rows[0];
}

async function createBankAccount(orgId, userId, body) {
  const [result] = await db.query(
    'INSERT INTO bank_accounts (organization_id, name, bank_name, account_hint, purpose, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, String(body.name).trim(), body.bank_name || null, body.account_hint || null, body.purpose || 'any', userId],
  );
  return bankAccountOr404(orgId, result.insertId);
}

async function updateBankAccount(orgId, id, body) {
  const current = await bankAccountOr404(orgId, id);
  const next = {
    name: body.name === undefined ? current.name : String(body.name).trim(),
    bank_name: body.bank_name === undefined ? current.bank_name : (body.bank_name || null),
    account_hint: body.account_hint === undefined ? current.account_hint : (body.account_hint || null),
    purpose: body.purpose === undefined ? current.purpose : body.purpose,
    status: body.status === undefined ? current.status : body.status,
  };
  await db.query(
    'UPDATE bank_accounts SET name = ?, bank_name = ?, account_hint = ?, purpose = ?, status = ? WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [next.name, next.bank_name, next.account_hint, next.purpose, next.status, id, orgId],
  );
  return bankAccountOr404(orgId, id);
}

async function listSafeMovements(orgId, range) {
  const [rows] = await db.query(
    `SELECT m.id, m.kind, m.amount, m.expected_amount, m.bank_account_id, a.name AS bank_account_name,
            m.moved_at, m.reference, m.note, m.created_by
       FROM cash_safe_movements m
       LEFT JOIN bank_accounts a ON a.id = m.bank_account_id AND a.organization_id = m.organization_id /* includes deleted rows: a deposit keeps naming its account */
      WHERE m.organization_id = ? AND m.moved_at >= ? AND m.moved_at < ? AND m.deleted_at IS NULL
      ORDER BY m.moved_at DESC, m.id DESC LIMIT 500`,
    [orgId, range.fromUtc, range.toUtc],
  );
  const names = await require('./cashReconciliationService').staffNames(rows.map((r) => r.created_by));
  return rows.map((r) => ({
    ...r, amount: Number(r.amount), expected_amount: r.expected_amount === null ? null : Number(r.expected_amount),
    created_by_name: names.get(Number(r.created_by)) || null,
  }));
}

/**
 * Record a safe movement. A count stores what the safe should have held, so
 * the difference stays on record; a deposit names an active bank account; and
 * nothing but a count may take more out of the safe than it holds.
 */
async function recordSafeMovement(orgId, userId, body) {
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${KINDS.join(', ')}`);
  const amount = round2(body.amount);
  const given = body.moved_at ? new Date(body.moved_at) : new Date();
  if (Number.isNaN(given.getTime())) throw new ValidationError('moved_at is not a date');
  // Whole seconds, as the column stores them (it would round a fraction up).
  const movedAt = new Date(Math.floor(given.getTime() / 1000) * 1000);
  if (movedAt.getTime() > Date.now() + 60 * 1000) throw new ValidationError('moved_at cannot be in the future');
  if (kind !== 'count' && !(amount > 0)) throw new ValidationError('amount must be more than 0');

  let accountId = null;
  if (kind === 'deposit') {
    if (!body.bank_account_id) throw new ValidationError('A deposit needs the bank account it went to');
    const account = await bankAccountOr404(orgId, body.bank_account_id);
    if (account.status !== 'active') throw new AppError('That bank account is inactive.', 422, 'BANK_ACCOUNT_INACTIVE');
    accountId = account.id;
  }

  // Recorded as happening now: everything up to this second counts.
  const balance = await safeBalance(orgId, body.moved_at ? movedAt : new Date(Date.now() + 2000));
  if (kind !== 'count') {
    if (balance === null) {
      throw new AppError('Count the safe first: its cash is tracked from the first count.', 422, 'SAFE_NOT_COUNTED');
    }
    if (kind !== 'other_in' && cents(amount) > cents(balance)) {
      const err = new AppError(
        `The safe holds ${balance.toFixed(2)}; ${amount.toFixed(2)} cannot be taken out of it. Count the safe if that is not what is in it.`,
        422, 'SAFE_INSUFFICIENT',
      );
      err.details = { in_safe: balance, amount };
      throw err;
    }
  }
  const [result] = await db.query(
    `INSERT INTO cash_safe_movements
       (organization_id, kind, amount, expected_amount, bank_account_id, moved_at, reference, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, kind, amount, kind === 'count' ? (balance === null ? 0 : balance) : null, accountId, movedAt,
      body.reference || null, body.note || null, userId],
  );
  return {
    id: result.insertId, kind, amount, expected_amount: kind === 'count' ? (balance === null ? 0 : balance) : null,
    bank_account_id: accountId, moved_at: movedAt.toISOString(), in_safe: await safeBalance(orgId, new Date(Date.now() + 2000)),
  };
}

/** Remove a movement recorded by mistake. The first count cannot go while other movements rest on it. */
async function removeSafeMovement(orgId, id) {
  const [rows] = await db.query(
    'SELECT id, kind, amount, moved_at FROM cash_safe_movements WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError('Safe movement');
  if (row.kind === 'count') {
    // The earliest count is where tracking starts: everything else rests on it.
    const [[other]] = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM cash_safe_movements c WHERE c.organization_id = ? AND c.kind = 'count' AND c.id <> ? AND c.deleted_at IS NULL
             AND (c.moved_at < ? OR (c.moved_at = ? AND c.id < ?))) AS earlier_counts,
         (SELECT COUNT(*) FROM cash_safe_movements m WHERE m.organization_id = ? AND m.id <> ? AND m.deleted_at IS NULL) AS others`,
      [orgId, id, row.moved_at, row.moved_at, id, orgId, id],
    );
    if (!Number(other.earlier_counts) && Number(other.others)) {
      throw new AppError('This is the count the safe is tracked from, and other movements rest on it. Remove those first.', 409, 'SAFE_COUNT_IN_USE');
    }
  }
  await db.query(
    'UPDATE cash_safe_movements SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  return { id: Number(id), kind: row.kind, amount: Number(row.amount) };
}

// ---------------------------------------------------------------------------
// Cash that has waited too long
// ---------------------------------------------------------------------------

async function attention(orgId, now, transit) {
  const items = [];
  const [bags] = await db.query(
    `SELECT b.id, b.serial, b.declared_amount, b.status, b.sealed_at, r.name AS point_name,
            TIMESTAMPDIFF(DAY, b.sealed_at, ?) AS days
       FROM cash_bags b
       LEFT JOIN resellers r ON r.id = b.reseller_id AND r.organization_id = b.organization_id /* includes deleted rows: a bag keeps naming its point */
      WHERE b.organization_id = ? AND b.status IN ('ready_for_pickup', 'in_transit') AND b.deleted_at IS NULL
        AND b.sealed_at < ? - INTERVAL ${BAG_MAX_DAYS} DAY
      ORDER BY b.sealed_at LIMIT 50`,
    [now, orgId, now],
  );
  for (const b of bags || []) {
    items.push({ kind: 'bag_waiting', bag_id: b.id, serial: b.serial, point_name: b.point_name, status: b.status, amount: Number(b.declared_amount), days: Number(b.days) });
  }
  const [pickups] = await db.query(
    `SELECT k.id, k.session_id, k.amount, TIMESTAMPDIFF(DAY, k.created_at, ?) AS days
       FROM cash_reconciliation_pickups k
      WHERE k.organization_id = ? AND k.status = 'pending' AND k.created_at < ? - INTERVAL ${PICKUP_MAX_DAYS} DAY
      ORDER BY k.created_at LIMIT 50`,
    [now, orgId, now],
  );
  for (const k of pickups || []) {
    items.push({ kind: 'pickup_unconfirmed', pickup_id: k.id, session_id: k.session_id, amount: Number(k.amount), days: Number(k.days) });
  }
  if (transit.in_safe === null) {
    items.push({ kind: 'safe_not_counted' });
  } else if (transit.in_safe > 0) {
    const [[last]] = await db.query(
      `SELECT TIMESTAMPDIFF(DAY, MAX(moved_at), ?) AS days FROM cash_safe_movements
        WHERE organization_id = ? AND kind IN ('deposit', 'count') AND moved_at < ? AND deleted_at IS NULL`,
      [now, orgId, now],
    );
    if (Number(last.days) >= SAFE_MAX_DAYS) items.push({ kind: 'safe_waiting', amount: transit.in_safe, days: Number(last.days) });
  }
  return items;
}

// ---------------------------------------------------------------------------
// RESICO: the year's income against the ceiling
// ---------------------------------------------------------------------------

async function resico(orgId, year) {
  const [profiles] = await db.query(
    'SELECT regimen_fiscal FROM organization_mx_profiles WHERE organization_id = ? AND deleted_at IS NULL',
    [orgId],
  );
  if (!profiles[0] || profiles[0].regimen_fiscal !== RESICO_REGIMEN) return { applies: false };
  // Income is what was collected, without its IVA: each allocation's share of
  // the invoice subtotal.
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(pa.amount * (i.subtotal / NULLIF(i.total, 0))), 0) AS income
       FROM payments p
       JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.deleted_at IS NULL
       JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = p.organization_id AND i.deleted_at IS NULL
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.payment_date >= ? AND p.payment_date < ?`,
    [orgId, `${year}-01-01`, `${year + 1}-01-01`],
  );
  const income = round2(row.income);
  return { applies: true, year, income, limit: RESICO_LIMIT, percent: Math.round((income / RESICO_LIMIT) * 1000) / 10 };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

async function report(orgId, year, month, now = new Date()) {
  const range = monthRange(year, month);
  if (range.fromUtc > now) throw new ValidationError('That month has not started');
  const closed = range.toUtc <= now;
  // An open month is read up to this moment. Timestamps are stored to the
  // second, so the cutoff sits just past it or the last second would be missed.
  const cutoff = closed ? range.toUtc : new Date(now.getTime() + 2000);

  const totals = await collected(orgId, range);
  const [fiscal, opening, closing, flows, recorded, kept, differences, accounts, resicoYear] = await Promise.all([
    fiscalSplit(orgId, range, totals),
    inTransit(orgId, range.fromUtc),
    inTransit(orgId, cutoff),
    safeFlows(orgId, range.fromUtc, cutoff),
    cashRecorded(orgId, range.fromUtc, cutoff),
    commissionsKept(orgId, range.fromUtc, cutoff),
    recordedDifferences(orgId, range.fromUtc, cutoff),
    listBankAccounts(orgId),
    resico(orgId, range.year),
  ]);

  const [deposits] = await db.query(
    `SELECT bank_account_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM cash_safe_movements
      WHERE organization_id = ? AND kind = 'deposit' AND moved_at >= ? AND moved_at < ? AND deleted_at IS NULL
      GROUP BY bank_account_id`,
    [orgId, range.fromUtc, cutoff],
  );
  const depositedBy = new Map((deposits || []).map((r) => [Number(r.bank_account_id), { count: Number(r.n), total: round2(r.total) }]));
  // Money that went straight to the bank (transfer, card, check, online), by
  // the account the payment names; NULL = the payment does not say.
  const [direct] = await db.query(
    `SELECT p.bank_account_id, COUNT(*) AS n, COALESCE(SUM(p.amount), 0) AS total FROM payments p
      WHERE p.organization_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.payment_method <> 'cash' AND p.payment_date >= ? AND p.payment_date < ?
      GROUP BY p.bank_account_id`,
    [orgId, range.from, range.to],
  );
  const receivedBy = new Map((direct || []).map((r) => [r.bank_account_id === null ? null : Number(r.bank_account_id), { count: Number(r.n), total: round2(r.total) }]));
  const inAccounts = { client_invoices: 0, general_public: 0, any: 0 };
  for (const a of accounts) {
    inAccounts[a.purpose] += cents(depositedBy.get(Number(a.id))?.total) + cents(receivedBy.get(Number(a.id))?.total);
  }

  // more cash than the records explain (+) or less (-)
  const differenceTotal = fromCents(
    cents(closing.position) - cents(opening.position)
    + cents(flows.deposits) + cents(flows.other_out) - cents(flows.other_in) + cents(kept) - cents(recorded),
  );
  const explained = Object.values(differences).reduce((n, v) => n + cents(v), 0);
  const tracked = closing.in_safe !== null;
  // The safe is followed from its first count. A month that began before it
  // cannot add up: cash from before that day was never followed.
  const counts = tracked ? await safeCounts(orgId, cutoff) : null;
  const trackingSince = counts ? new Date(counts.since) : null;
  const startedInMonth = Boolean(trackingSince && trackingSince > range.fromUtc);

  return {
    period: {
      year: range.year, month: range.month, from: range.from, to: range.to,
      cutoff: cutoff.toISOString(), closed, today: businessToday(),
    },
    collected: totals,
    fiscal,
    cash: {
      tracked,
      tracking_since: trackingSince ? trackingSince.toISOString() : null,
      started_in_month: startedInMonth,
      recorded,
      in_transit_start: opening,
      in_transit_end: closing,
      deposited: flows.deposits,
      commissions_kept: kept,
      other_out: flows.other_out,
      other_in: flows.other_in,
      reached_safe: { pickups: flows.pickups, bags: flows.bags, handed_in: flows.handed_in },
      differences: tracked
        ? { total: differenceTotal, ...differences, unexplained: fromCents(cents(differenceTotal) - explained) }
        : null,
    },
    bank: {
      deposited: flows.deposits,
      // Cash collected in the month, by the account it belongs in.
      cash_for_client_invoices: fiscal.cash.client_cfdi,
      cash_for_general_public: fiscal.cash.general_public,
      // All of the month's money, by the account it belongs in, next to what
      // the accounts of each purpose received (cash deposits + direct payments).
      for_client_invoices: fiscal.client_cfdi,
      for_general_public: fiscal.general_public,
      in_client_invoice_accounts: fromCents(inAccounts.client_invoices),
      in_general_public_accounts: fromCents(inAccounts.general_public),
      in_other_accounts: fromCents(inAccounts.any),
      // Paid by transfer, card or check with no bank account named.
      direct_unassigned: receivedBy.get(null)?.total || 0,
      accounts: accounts.map((a) => ({
        id: a.id, name: a.name, bank_name: a.bank_name, account_hint: a.account_hint, purpose: a.purpose, status: a.status,
        deposits: depositedBy.get(Number(a.id))?.count || 0, deposited: depositedBy.get(Number(a.id))?.total || 0,
        payments: receivedBy.get(Number(a.id))?.count || 0, received: receivedBy.get(Number(a.id))?.total || 0,
      })),
    },
    attention: await attention(orgId, now, closed ? await inTransit(orgId, new Date(now.getTime() + 2000)) : closing),
    resico: resicoYear,
  };
}

module.exports = {
  report, monthRange, inTransit, safeBalance, safeFlows,
  listBankAccounts, createBankAccount, updateBankAccount,
  listSafeMovements, recordSafeMovement, removeSafeMovement,
  PURPOSES, KINDS, BAG_MAX_DAYS, SAFE_MAX_DAYS, PICKUP_MAX_DAYS, RESICO_LIMIT,
};
