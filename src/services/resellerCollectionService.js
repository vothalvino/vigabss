// =============================================================================
// VigaBSS 5.0 — Cash collection by a reseller (reseller app, phase 2)
// =============================================================================
// A reseller (Punto de Venta) is the ISP's commission agent: it takes cash
// from a subscriber on the ISP's behalf. The ISP stays the provider and the
// CFDI issuer, so a collection is an ordinary completed cash payment of the
// client, posted exactly like a staff or gateway payment:
//
//   one transaction, reseller row locked first (resellerLedgerService), then
//   the client's invoices (DAL-04: before any plain read fixes the snapshot):
//     credit check  cash_on_hand + amount <= effective credit limit, else 409
//     cash session  the collecting user's open session, opened if none
//     payments row  cash, SAT forma 01, completed, recorded_by = the user,
//                   reseller_id = the collecting reseller: the top-level
//                   reseller of the user's binding (a sub-reseller's user
//                   collects for its parent, which holds the ledger)
//     client ledger billingService.recordPaymentCredit
//     allocation    getInvoicesWithBalance and allocateAcrossInvoices, the
//                   waterfall of POST /payments/:id/allocate-auto
//     reseller      reseller_ledger_entries 'collection' +amount
//   after commit, best effort (logged, never failing the response):
//     businessEvents.emitPaymentReceived,
//     paymentAllocationService.reconnectIfSuspended per invoice it paid off,
//     repService.maybeGenerateRep per allocation (MX PPD invoices only).
//
// A void reverses it the way a staff payment deletion does
// (billingService.reversePaymentCredit and reversePaymentAllocations, refused
// while a REP binds the payment) and appends 'collection_void' with the
// negated amount of its 'collection' entry. Only the user whose cash box holds
// the collection may void it.
//
// A reseller may collect from ANY subscriber of the organization. Its own
// subtree's clients are fully visible; any other client is found only by an
// exact customer number or phone, and shows a masked name and no contact
// data. The lookup hands out a signed, 15-minute collect token
// (utils/collectToken.js) that the payment needs instead of a client id.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'resellerCollection' });
const money = require('../utils/money');
const { AppError, ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const { inPlaceholders } = require('../utils/sqlBuild');
const { paidOrCreditedSql } = require('../utils/invoiceBalance');
const { businessToday, businessDate, businessDayStartUtc, addDays } = require('../utils/businessDate');
const { FORMA_PAGO_BY_METHOD } = require('../utils/satCatalogs');
const { signCollectToken, verifyCollectToken } = require('../utils/collectToken');
const { runInPrimaryContext } = require('../utils/primaryContext');
const paymentAllocationService = require('./paymentAllocationService');
const billingService = require('./billingService');
const repService = require('./repService');
const auditLog = require('./auditLog');
const ledger = require('./resellerLedgerService');
const thermal = require('./thermalReceiptService');
const Organization = require('../models/Organization');

const { PAYABLE_STATUSES } = paymentAllocationService;
const PAYABLE_IN = PAYABLE_STATUSES.map(() => '?').join(', ');
const OPEN_BALANCE_SQL = `GREATEST(i.total - ${paidOrCreditedSql('i')}, 0)`;

const LOOKUP_LIMIT = 5;
const OPEN_INVOICES_LIMIT = 24;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// payments.amount is DECIMAL(10,2).
const MAX_AMOUNT = 99999999.99;

const toMoney = (v) => money.round(v === null || v === undefined || v === '' ? 0 : v);

// -----------------------------------------------------------------------------
// Names and lookup input
// -----------------------------------------------------------------------------

/** "María López Pérez" -> "Ma*** Ló*** Pé***": two letters of each word. */
function maskName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (!words.length) return '***';
  return words.map((w) => {
    const chars = Array.from(w);
    return `${chars.slice(0, chars.length > 2 ? 2 : 1).join('')}***`;
  }).join(' ');
}

/** Whether the client belongs to the caller's reseller subtree. */
function isOwn(scope, client) {
  const rid = client && client.reseller_id;
  return rid !== null && rid !== undefined && scope.resellerIds.includes(Number(rid));
}

const displayName = (scope, client) => (isOwn(scope, client) ? client.name : maskName(client.name));

/**
 * Phone numbers a stored phone may equal, in digits only. Mexican numbers are
 * stored in many forms (10 digits, +52, the old +521 mobile prefix), so a
 * 10-digit national number matches all three.
 */
function phoneCandidates(digits) {
  const d = digits.startsWith('00') ? digits.slice(2) : digits;
  if (d.length < 7 || d.length > 15) return [];
  let national = null;
  if (d.length === 10) national = d;
  else if (d.length === 12 && d.startsWith('52')) national = d.slice(2);
  else if (d.length === 13 && d.startsWith('521')) national = d.slice(3);
  return national ? [national, `52${national}`, `521${national}`] : [d];
}

/**
 * q is an exact customer number ("123" or "#123") or an exact phone (digits,
 * spaces, dashes, dots, parentheses, a leading +). Digits alone may be either.
 * @returns {{ clientId: number|null, phones: string[] }|null}
 */
function parseLookupQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim() : '';
  if (!q || q.length > 40) return null;
  const byNumber = /^#\s*(\d{1,12})$/.exec(q);
  if (byNumber) return { clientId: Number(byNumber[1]), phones: [] };
  if (!/^\+?[\d\s.()-]+$/.test(q)) return null;
  const digits = q.replace(/\D/g, '');
  if (!digits) return null;
  const clientId = /^\d{1,12}$/.test(q) && Number(q) > 0 ? Number(q) : null;
  const phones = phoneCandidates(digits);
  if (clientId === null && !phones.length) return null;
  return { clientId, phones };
}

// The stored phone without the separators people type.
const PHONE_DIGITS_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')";

// -----------------------------------------------------------------------------
// Collect targets (lookup and the own client's Cobrar button)
// -----------------------------------------------------------------------------

/** Open invoices of the clients, oldest first: Map(clientId → rows). */
async function openInvoicesFor(orgId, clientIds, currency) {
  const out = new Map(clientIds.map((id) => [Number(id), []]));
  if (!clientIds.length) return out;
  const [rows] = await db.query(
    `SELECT i.id, i.client_id, i.invoice_number, i.due_date, i.currency, ${OPEN_BALANCE_SQL} AS balance
       FROM invoices i
      WHERE i.organization_id = ? AND i.client_id IN (${inPlaceholders(clientIds)})
        AND i.deleted_at IS NULL AND i.status IN (${PAYABLE_IN})
      ORDER BY i.issue_date ASC, i.id ASC`,
    [orgId, ...clientIds, ...PAYABLE_STATUSES],
  );
  for (const r of rows || []) {
    // A collection is in the organization currency; another currency's
    // invoice stays out of the waterfall (allocationRefusal), so out of here.
    if (r.currency && currency && String(r.currency).toUpperCase() !== String(currency).toUpperCase()) continue;
    if (toMoney(r.balance) <= 0) continue;
    const list = out.get(Number(r.client_id));
    if (list && list.length < OPEN_INVOICES_LIMIT) {
      list.push({ id: Number(r.id), invoice_number: r.invoice_number, balance: toMoney(r.balance), due_date: r.due_date });
    }
  }
  return out;
}

async function buildTargets(req, clients) {
  const scope = req.resellerScope;
  const currency = await Organization.getCurrency(req.orgId);
  const invoices = await openInvoicesFor(req.orgId, clients.map((c) => Number(c.id)), currency);
  return clients.map((c) => {
    const open = invoices.get(Number(c.id)) || [];
    return {
      collect_token: signCollectToken({ orgId: req.orgId, clientId: Number(c.id), rootResellerId: scope.rootId }),
      own: isOwn(scope, c),
      client_number: Number(c.id),
      name: displayName(scope, c),
      status: c.status,
      amount_due: money.add(...open.map((i) => i.balance), 0),
      open_invoices: open,
    };
  });
}

/** GET /reseller-app/collect/lookup: up to 5 clients of the whole organization. */
async function lookup(req, rawQuery) {
  const parsed = parseLookupQuery(rawQuery);
  if (!parsed) throw new ValidationError('q must be an exact customer number (e.g. #123) or phone number');
  const conditions = [];
  const params = [req.orgId];
  if (parsed.clientId !== null) { conditions.push('c.id = ?'); params.push(parsed.clientId); }
  if (parsed.phones.length) {
    conditions.push(`${PHONE_DIGITS_SQL} IN (${inPlaceholders(parsed.phones)})`);
    params.push(...parsed.phones);
  }
  // Only what a collection needs: never a non-own client's contact data.
  const [rows] = await db.query(
    `SELECT c.id, c.name, c.status, c.reseller_id
       FROM clients c
      WHERE c.organization_id = ? AND c.deleted_at IS NULL AND (${conditions.join(' OR ')})
      ORDER BY c.id ASC
      LIMIT ${LOOKUP_LIMIT}`,
    params,
  );
  return buildTargets(req, rows || []);
}

/** GET /reseller-app/collect/client/:id: an own (subtree) client, 404 otherwise. */
async function targetForOwnClient(req, clientId) {
  const id = Number(clientId);
  const ids = req.resellerScope.resellerIds;
  if (!Number.isInteger(id) || id < 1 || !ids.length) throw new NotFoundError('Client');
  const [rows] = await db.query(
    `SELECT c.id, c.name, c.status, c.reseller_id
       FROM clients c
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL
        AND c.reseller_id IN (${inPlaceholders(ids)})
      LIMIT 1`,
    [id, req.orgId, ...ids],
  );
  if (!rows || !rows[0]) throw new NotFoundError('Client');
  return (await buildTargets(req, rows))[0];
}

// -----------------------------------------------------------------------------
// Collect
// -----------------------------------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** The stored idempotency key: per user, so two users never share one. */
function idempotencyKeyFor(userId, key) {
  return `reseller-collect:${userId}:${key}`;
}

function creditLimitRefusal(summary, amount) {
  const err = new AppError(
    `This collection would exceed your cash limit. You can still collect ${summary.available_to_collect.toFixed(2)}; hand in the cash you hold to keep collecting.`,
    409, 'CREDIT_LIMIT',
  );
  err.extra = {
    available_to_collect: summary.available_to_collect,
    credit_limit: summary.credit_limit,
    cash_on_hand: summary.cash_on_hand,
    amount: toMoney(amount),
  };
  return err;
}

/** The stored answer of an idempotency key, or null. */
async function storedAnswer(exec, orgId, storedKey, forUpdate) {
  const [rows] = await exec(
    `SELECT response_code, response_body FROM idempotency_keys
      WHERE organization_id = ? AND idempotency_key = ? AND expires_at > NOW()
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orgId, storedKey],
  );
  if (!rows || !rows[0]) return null;
  const stored = rows[0].response_body;
  return {
    status: Number(rows[0].response_code) || 201,
    body: typeof stored === 'string' ? JSON.parse(stored) : stored,
    replayed: true,
  };
}

/** The collecting user's open cash session on the transaction, opened if none. */
async function openCashSession(exec, orgId, userId) {
  const [rows] = await exec(
    `SELECT id FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1
      FOR UPDATE`,
    [orgId, userId],
  );
  if (rows && rows[0]) return Number(rows[0].id);
  const [result] = await exec(
    `INSERT INTO cash_reconciliation_sessions (organization_id, agent_user_id, opened_at, status, notes)
     VALUES (?, ?, NOW(), 'open', 'Opened by the reseller app')`,
    [orgId, userId],
  );
  return Number(result.insertId);
}

/**
 * Record a cash collection. Returns { status, body, replayed }.
 * @param {object} req - authenticated, org-scoped, bound (req.resellerScope)
 * @param {{ collect_token: string, amount: number, invoice_ids?: number[], note?: string }} body
 * @param {string|null} idempotencyKey
 */
async function collect(req, body, idempotencyKey = null) {
  const orgId = req.orgId;
  const userId = req.user.id;
  const scope = req.resellerScope;
  // The bound reseller signs the collect token; the money is booked on its
  // top-level reseller.
  const boundId = scope.rootId;
  const collectorId = await ledger.collectingResellerId(req);

  let storedKey = null;
  if (idempotencyKey !== null && idempotencyKey !== undefined && idempotencyKey !== '') {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new ValidationError('Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores');
    }
    storedKey = idempotencyKeyFor(userId, idempotencyKey);
    // A retry after the collect token expired still gets its first answer.
    const replay = await storedAnswer(db.query.bind(db), orgId, storedKey, false);
    if (replay) return replay;
  }

  const token = verifyCollectToken(body.collect_token, { orgId, rootResellerId: boundId });
  if (!token.ok) {
    throw token.reason === 'expired'
      ? new AppError('This collection expired; look the customer up again.', 422, 'COLLECT_TOKEN_EXPIRED')
      : new AppError('This collection is not valid; look the customer up again.', 422, 'COLLECT_TOKEN_INVALID');
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT || money.round(amount) !== amount) {
    throw new ValidationError('amount must be more than 0 with at most 2 decimals');
  }
  let invoiceIds = null;
  if (body.invoice_ids !== undefined && body.invoice_ids !== null) {
    if (!Array.isArray(body.invoice_ids) || !body.invoice_ids.length
      || body.invoice_ids.some((v) => !Number.isInteger(v) || v < 1) || body.invoice_ids.length > 50) {
      throw new ValidationError('invoice_ids must be a non-empty array of invoice ids');
    }
    invoiceIds = [...new Set(body.invoice_ids)];
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  const currency = await Organization.getCurrency(orgId);

  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let posted;
  try {
    await conn.beginTransaction();

    // 1. The collecting reseller, locked: collections and deposits of one
    // reseller serialize here, so the credit check below cannot race.
    const reseller = await ledger.lockReseller(exec, orgId, collectorId);
    if (!reseller) throw new NotFoundError('Reseller');

    // 2. A retry of a collection already made answers what it answered (a
    // concurrent retry waits on the reseller lock and finds it here).
    if (storedKey) {
      const replay = await storedAnswer(exec, orgId, storedKey, true);
      if (replay) {
        await conn.rollback();
        return replay;
      }
      await exec(
        'DELETE FROM idempotency_keys WHERE organization_id = ? AND idempotency_key = ? AND expires_at <= NOW()',
        [orgId, storedKey],
      );
    }

    if (reseller.status !== 'active') {
      throw new ForbiddenError('Your reseller account is not active; contact the ISP');
    }

    // 3. The client's invoices, locked before the first plain read of this
    // transaction (DAL-04). Under REPEATABLE READ that read fixes the snapshot,
    // and the balance_due subquery and the over-allocation trigger sum
    // payment_allocations from it: a snapshot taken before another allocator
    // (another reseller, staff, a gateway) committed would let this
    // collection over-allocate an invoice. Lock order: reseller -> invoices.
    await paymentAllocationService.lockInvoicesForAllocation(exec, orgId, { clientIds: [token.clientId] });

    // 4. The bound reseller (when it is a sub-reseller) must be active too.
    if (boundId !== collectorId) {
      const [boundRows] = await exec(
        'SELECT status FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [boundId, orgId],
      );
      if (!boundRows || !boundRows[0] || boundRows[0].status !== 'active') {
        throw new ForbiddenError('Your reseller account is not active; contact the ISP');
      }
    }

    // 5. The credit limit: exactly at the limit is allowed.
    const summary = await ledger.summaryFor(orgId, collectorId, { exec, reseller });
    if (money.toCents(money.add(summary.cash_on_hand, amount)) > money.toCents(summary.credit_limit)) {
      throw creditLimitRefusal(summary, amount);
    }

    // 6. The client, still live in the organization, and the waterfall
    // targets, oldest first.
    const [clientRows] = await exec(
      `SELECT id, name, status, reseller_id FROM clients
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [token.clientId, orgId],
    );
    const client = clientRows && clientRows[0];
    if (!client) throw new NotFoundError('Client');
    const payer = { organization_id: orgId, client_id: Number(client.id), currency };
    let invoices = await paymentAllocationService.getInvoicesWithBalance(exec, orgId, client.id, invoiceIds, true);
    if (invoiceIds) {
      const found = new Set(invoices.map((i) => Number(i.id)));
      const missing = invoiceIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw new AppError(`Invoice(s) ${missing.join(', ')} are not open invoices of this customer.`, 422, 'INVOICE_NOT_PAYABLE');
      }
    }
    invoices = invoices.filter((inv) => !paymentAllocationService.allocationRefusal(payer, inv));

    // 7. The collecting user's cash session.
    const cashSessionId = await openCashSession(exec, orgId, userId);

    // 8. The payment, its client-ledger credit and its allocations.
    const [payResult] = await exec(
      `INSERT INTO payments
         (organization_id, client_id, invoice_id, amount, currency, payment_method, sat_forma_pago,
          reference_number, notes, status, payment_date, recorded_by, reseller_id)
       VALUES (?, ?, NULL, ?, ?, 'cash', ?, NULL, ?, 'completed', ?, ?, ?)`,
      [orgId, client.id, amount, currency, FORMA_PAGO_BY_METHOD.cash, note, businessToday(), userId, collectorId],
    );
    const paymentId = Number(payResult.insertId);
    await billingService.recordPaymentCredit(
      { id: paymentId, client_id: client.id, amount, currency, reference_number: null }, orgId, exec,
    );
    const { allocations, justPaidInvoices } = await paymentAllocationService.allocateAcrossInvoices(
      exec, { payment: { ...payer, id: paymentId }, amount, invoices },
    );

    // 9. What the reseller now owes the ISP.
    const entryId = await ledger.appendEntry(exec, {
      orgId, resellerId: collectorId, entryType: 'collection', amount, currency,
      paymentId, cashSessionId, note, createdBy: userId,
    });

    const responseBody = {
      data: {
        payment_id: paymentId,
        amount: toMoney(amount),
        allocated: allocations.map((a) => ({ invoice_id: Number(a.invoice_id), amount: toMoney(a.amount) })),
        client_number: Number(client.id),
        client_name: displayName(scope, client),
        reconnected: null,
        receipt_url: `/reseller-app/payments/${paymentId}/receipt`,
      },
    };
    if (storedKey) {
      await exec(
        `INSERT INTO idempotency_keys (organization_id, idempotency_key, status, response_code, response_body, expires_at)
         VALUES (?, ?, 'completed', 201, ?, ?)`,
        [orgId, storedKey, JSON.stringify(responseBody), new Date(Date.now() + IDEMPOTENCY_TTL_MS)],
      );
    }

    await conn.commit();
    posted = { paymentId, client, allocations, justPaidInvoices, entryId, cashSessionId, responseBody };
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }

  const { paymentId, client, allocations, justPaidInvoices, entryId, cashSessionId, responseBody } = posted;
  logger.info({ orgId, resellerId: collectorId, paymentId, amount, allocated: allocations.length }, 'Reseller collection posted');

  // Post-commit, best effort: the money is already posted.
  await afterCommit(() => auditLog.log({
    userId, organizationId: orgId, action: 'reseller_collect', tableName: 'payments', recordId: paymentId,
    newValues: {
      reseller_id: collectorId, client_id: Number(client.id), amount: toMoney(amount), payment_method: 'cash',
      cash_session_id: cashSessionId, ledger_entry_id: entryId,
    },
  }), 'audit log');
  await afterCommit(() => require('./businessEvents').emitPaymentReceived(orgId, paymentId), 'payment.received event');

  let reconnected = false;
  let reconnectFailed = false;
  for (const invoice of justPaidInvoices) {
    try {
      if (await paymentAllocationService.reconnectIfSuspended(invoice, userId, orgId)) reconnected = true;
    } catch (err) {
      reconnectFailed = true;
      logger.error({ err, paymentId, invoiceId: invoice.id }, 'Reconnect after reseller collection failed');
    }
  }
  for (const a of allocations) {
    await afterCommit(() => repService.maybeGenerateRep(paymentId, a.invoice_id, a.amount, orgId, userId), 'REP generation');
  }

  responseBody.data.reconnected = reconnected ? true : (reconnectFailed ? null : false);
  if (storedKey) {
    await afterCommit(() => db.query(
      'UPDATE idempotency_keys SET response_body = ? WHERE organization_id = ? AND idempotency_key = ?',
      [JSON.stringify(responseBody), orgId, storedKey],
    ), 'idempotency record update');
  }
  return { status: 201, body: responseBody, replayed: false };
}

async function afterCommit(fn, what) {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err }, `Reseller collection: ${what} failed after commit`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Void
// -----------------------------------------------------------------------------

function conflict(message, code) {
  return new AppError(message, 409, code);
}

/**
 * Void a collection: only the collecting reseller, only by the user whose cash
 * box holds it, only on the business day it was taken, only while that cash
 * session is open, never while a REP binds it.
 */
async function voidCollection(req, paymentId, reason) {
  const orgId = req.orgId;
  const userId = req.user.id;
  const collectorId = await ledger.collectingResellerId(req);
  const id = Number(paymentId);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('Payment');

  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let voided;
  try {
    await conn.beginTransaction();
    const reseller = await ledger.lockReseller(exec, orgId, collectorId);
    if (!reseller) throw new NotFoundError('Reseller');

    const [payRows] = await exec(
      `/* includes deleted rows: a voided collection answers 409, not 404 */
       SELECT id, client_id, amount, currency, status, created_at, deleted_at, recorded_by
         FROM payments
        WHERE id = ? AND organization_id = ? AND reseller_id = ?
        FOR UPDATE`,
      [id, orgId, collectorId],
    );
    const payment = payRows && payRows[0];
    if (!payment) throw new NotFoundError('Payment');
    // Its client's invoices, before the first plain read (DAL-04): the
    // reversal below recomputes their status from the allocations it sees.
    await paymentAllocationService.lockInvoicesForAllocation(exec, orgId, { clientIds: [payment.client_id] });
    if (payment.deleted_at || payment.status !== 'completed') {
      throw conflict('This collection is already voided.', 'ALREADY_VOIDED');
    }
    if (businessDate(new Date(payment.created_at)) !== businessToday()) {
      throw conflict('A collection can only be voided on the day it was taken; ask the ISP to correct it.', 'VOID_WINDOW_CLOSED');
    }

    const [entryRows] = await exec(
      `SELECT id, amount, cash_session_id FROM reseller_ledger_entries
        WHERE organization_id = ? AND reseller_id = ? AND payment_id = ? AND entry_type = 'collection'
        LIMIT 1`,
      [orgId, collectorId, id],
    );
    const entry = entryRows && entryRows[0];
    if (!entry) throw new NotFoundError('Payment');
    const cashSessionId = entry.cash_session_id === null || entry.cash_session_id === undefined
      ? null : Number(entry.cash_session_id);
    // The cash is in the drawer of the user who took it: only that user may
    // void it (a colleague bound to the same reseller may not).
    let sessionOwner = payment.recorded_by === null || payment.recorded_by === undefined ? null : Number(payment.recorded_by);
    if (cashSessionId !== null) {
      const [sessionRows] = await exec(
        `SELECT status, agent_user_id FROM cash_reconciliation_sessions
          WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
          FOR UPDATE`,
        [cashSessionId, orgId],
      );
      const session = sessionRows && sessionRows[0];
      if (session) sessionOwner = Number(session.agent_user_id);
      if (sessionOwner !== Number(userId)) {
        throw conflict('Only the person who took this cash can void it.', 'NOT_YOUR_COLLECTION');
      }
      if (!session || session.status !== 'open') {
        throw conflict('The cash box of this collection is already closed; ask the ISP to correct it.', 'CASH_SESSION_CLOSED');
      }
    } else if (sessionOwner !== Number(userId)) {
      throw conflict('Only the person who took this cash can void it.', 'NOT_YOUR_COLLECTION');
    }

    try {
      await repService.assertNoBindingRep(exec, { paymentId: id, orgId });
    } catch (err) {
      if (err && err.code === 'PAYMENT_HAS_REP') {
        throw conflict('This collection is already reported to SAT with a payment complement; ask the ISP to cancel it.', 'PAYMENT_HAS_REP');
      }
      throw err;
    }

    // The staff deletion's reversal (routes/payments.js beforeDelete), with
    // the invoices locked first.
    const [allocRows] = await exec(
      'SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = ? AND deleted_at IS NULL',
      [id],
    );
    const invoiceIds = (allocRows || []).map((r) => Number(r.invoice_id)).filter(Boolean);
    // Normally all on the client locked above; a reassigned payment's too.
    await paymentAllocationService.lockInvoicesForAllocation(exec, orgId, { invoiceIds });
    await billingService.reversePaymentCredit(id, exec);
    await billingService.reversePaymentAllocations(id, exec);

    const [upd] = await exec(
      `UPDATE payments SET status = 'cancelled', deleted_at = NOW()
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [id, orgId],
    );
    if (!upd || upd.affectedRows === 0) throw new NotFoundError('Payment');

    // The void nets the collection entry to zero: what the reseller took, not
    // the payment's current amount (staff may have edited it since).
    const collected = toMoney(entry.amount);
    const entryId = await ledger.appendEntry(exec, {
      orgId, resellerId: collectorId, entryType: 'collection_void', amount: -collected,
      currency: payment.currency, paymentId: id, cashSessionId, note: reason, createdBy: userId,
    });
    await conn.commit();
    voided = { payment, entryId, cashSessionId, invoiceIds, collected };
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }

  await afterCommit(() => auditLog.log({
    userId, organizationId: orgId, action: 'void', tableName: 'payments', recordId: id,
    oldValues: { status: 'completed', amount: toMoney(voided.payment.amount) },
    newValues: {
      status: 'cancelled', reason, reseller_id: collectorId, ledger_entry_id: voided.entryId,
      ledger_amount: -voided.collected, reversed_invoice_ids: voided.invoiceIds,
    },
  }), 'audit log');
  return {
    payment_id: id,
    status: 'voided',
    amount: voided.collected,
    ledger_entry_id: voided.entryId,
  };
}

// -----------------------------------------------------------------------------
// Collections list and receipt
// -----------------------------------------------------------------------------

function isValidDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/** GET /reseller-app/payments: the collecting reseller's collections of one business day. */
async function listCollections(req, { date, limit, offset }) {
  const orgId = req.orgId;
  const scope = req.resellerScope;
  const day = date || businessToday();
  if (!isValidDate(day)) throw new ValidationError('date must be YYYY-MM-DD');
  const from = businessDayStartUtc(day);
  const to = businessDayStartUtc(addDays(day, 1));
  const today = businessToday();
  const collectorId = await ledger.collectingResellerId(req);

  const where = 'p.organization_id = ? AND p.reseller_id = ? AND p.created_at >= ? AND p.created_at < ?';
  const params = [orgId, collectorId, from, to];
  const [rows] = await db.query(
    `/* includes deleted rows: a voided collection stays on the day's list as voided */
     SELECT p.id, p.client_id, p.amount, p.currency, p.status, p.created_at, p.deleted_at,
            c.name AS client_name, c.reseller_id AS client_reseller_id,
            (SELECT e.cash_session_id FROM reseller_ledger_entries e
              WHERE e.organization_id = p.organization_id AND e.payment_id = p.id AND e.entry_type = 'collection'
              LIMIT 1) AS cash_session_id,
            (SELECT s.status FROM reseller_ledger_entries e
               JOIN cash_reconciliation_sessions s ON s.id = e.cash_session_id AND s.organization_id = e.organization_id
                AND s.deleted_at IS NULL
              WHERE e.organization_id = p.organization_id AND e.payment_id = p.id AND e.entry_type = 'collection'
              LIMIT 1) AS cash_session_status,
            (SELECT s.agent_user_id FROM reseller_ledger_entries e
               JOIN cash_reconciliation_sessions s ON s.id = e.cash_session_id AND s.organization_id = e.organization_id
                AND s.deleted_at IS NULL
              WHERE e.organization_id = p.organization_id AND e.payment_id = p.id AND e.entry_type = 'collection'
              LIMIT 1) AS cash_session_user_id
       FROM payments p
       LEFT JOIN clients c ON c.id = p.client_id AND c.organization_id = p.organization_id
      WHERE ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );
  const [[count]] = await db.query(
    `/* includes deleted rows: voided collections are counted on the list */
     SELECT COUNT(*) AS total FROM payments p WHERE ${where}`,
    params,
  );

  const ids = (rows || []).map((r) => Number(r.id));
  const numbers = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const [allocs] = await db.query(
      `/* includes deleted rows: a voided collection still names the invoices it had paid */
       SELECT pa.payment_id, i.invoice_number
         FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id AND p.organization_id = ?
         JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = p.organization_id
        WHERE pa.payment_id IN (${inPlaceholders(ids)})
          AND (pa.deleted_at IS NULL OR p.status = 'cancelled')
        ORDER BY pa.id ASC`,
      [orgId, ...ids],
    );
    for (const a of allocs || []) {
      const list = numbers.get(Number(a.payment_id));
      if (list && a.invoice_number && !list.includes(a.invoice_number)) list.push(a.invoice_number);
    }
  }

  const data = (rows || []).map((r) => {
    const voided = Boolean(r.deleted_at) || r.status !== 'completed';
    const client = { name: r.client_name, reseller_id: r.client_reseller_id };
    return {
      id: Number(r.id),
      client_number: Number(r.client_id),
      client_name: displayName(scope, client),
      own: isOwn(scope, client),
      amount: toMoney(r.amount),
      currency: r.currency,
      collected_at: r.created_at,
      status: voided ? 'voided' : 'completed',
      invoice_numbers: numbers.get(Number(r.id)) || [],
      cash_session_id: r.cash_session_id === null || r.cash_session_id === undefined ? null : Number(r.cash_session_id),
      // Only the user whose open cash box holds it may void it.
      voidable: !voided && businessDate(new Date(r.created_at)) === today && r.cash_session_status === 'open'
        && Number(r.cash_session_user_id) === Number(req.user.id),
    };
  });
  return { data, meta: { total: Number(count?.total) || 0, date: day } };
}

const RECEIPT_TEXT = {
  es: {
    title: 'RECIBO DE PAGO', number: 'Recibo:', date: 'Fecha:', client: 'Cliente:', method: 'Forma de pago:',
    cash: 'Efectivo', applied: 'Aplicado a:', total: 'TOTAL:', remaining: 'Saldo pendiente:', voided: 'ANULADO',
    legend: (reseller, isp) => `Cobrado por ${reseller} a nombre de ${isp}. El pago queda registrado con ${isp}.`,
  },
  en: {
    title: 'PAYMENT RECEIPT', number: 'Receipt:', date: 'Date:', client: 'Customer:', method: 'Payment method:',
    cash: 'Cash', applied: 'Applied to:', total: 'TOTAL:', remaining: 'Balance due:', voided: 'VOIDED',
    legend: (reseller, isp) => `Collected by ${reseller} on behalf of ${isp}. The payment is recorded with ${isp}.`,
  },
};

function receiptPlainText(r, width, lang) {
  const { center, labelValue, wrap, divider } = thermal.layout;
  const t = RECEIPT_TEXT[lang];
  const fmt = (v) => `${r.currency} ${toMoney(v).toFixed(2)}`;
  const lines = [];
  const D = divider(width);
  const D2 = divider(width, '=');
  lines.push(D2);
  for (const l of wrap(r.isp.name, width)) lines.push(center(l, width));
  if (r.isp.rfc) lines.push(center(`RFC ${r.isp.rfc}`, width));
  if (r.isp.address) for (const l of wrap(r.isp.address, width)) lines.push(center(l, width));
  if (r.isp.phone) lines.push(center(r.isp.phone, width));
  lines.push(D2);
  lines.push(center(t.title, width));
  if (r.status === 'voided') lines.push(center(`*** ${t.voided} ***`, width));
  lines.push(labelValue(t.number, r.receipt_number, width));
  lines.push(labelValue(t.date, String(r.issued_local), width));
  lines.push(D);
  lines.push(t.client);
  lines.push(`#${r.client.number} ${r.client.name}`.slice(0, width));
  lines.push(labelValue(t.method, t.cash, width));
  if (r.allocations.length) {
    lines.push(D);
    lines.push(t.applied);
    for (const a of r.allocations) lines.push(labelValue(a.invoice_number || '-', fmt(a.amount), width));
  }
  lines.push(D2);
  lines.push(labelValue(t.total, fmt(r.amount), width));
  lines.push(D2);
  if (r.remaining_balance !== null) lines.push(labelValue(t.remaining, fmt(r.remaining_balance), width));
  lines.push(...wrap(r.legend, width));
  lines.push('');
  return lines.join('\n');
}

/** The local wall time of an instant in the business zone, "YYYY-MM-DD HH:MM". */
function localStamp(instant) {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  const tz = require('../utils/businessDate').businessTimezone();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** GET /reseller-app/payments/:id/receipt: a collection of this reseller, 404 otherwise. */
async function receipt(req, paymentId, { width = 32 } = {}) {
  const orgId = req.orgId;
  const scope = req.resellerScope;
  const id = Number(paymentId);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('Payment');
  const collectorId = await ledger.collectingResellerId(req);
  const [rows] = await db.query(
    `/* includes deleted rows: a voided collection's receipt shows it voided */
     SELECT p.id, p.client_id, p.amount, p.currency, p.status, p.created_at, p.deleted_at, p.recorded_by,
            c.name AS client_name, c.reseller_id AS client_reseller_id,
            r.name AS reseller_name,
            o.name AS org_name, o.legal_name AS org_legal_name, o.tax_id AS org_tax_id, o.locale AS org_locale,
            o.phone AS org_phone, o.address AS org_address, o.city AS org_city, o.state AS org_state
       FROM payments p
       LEFT JOIN clients c ON c.id = p.client_id AND c.organization_id = p.organization_id
       LEFT JOIN resellers r ON r.id = p.reseller_id AND r.organization_id = p.organization_id
       LEFT JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = ? AND p.organization_id = ? AND p.reseller_id = ?
      LIMIT 1`,
    [id, orgId, collectorId],
  );
  const p = rows && rows[0];
  if (!p) throw new NotFoundError('Payment');
  const voided = Boolean(p.deleted_at) || p.status !== 'completed';

  const [allocs] = await db.query(
    `/* includes deleted rows: a voided collection's receipt names what it had paid */
     SELECT i.invoice_number, pa.amount
       FROM payment_allocations pa
       JOIN invoices i ON i.id = pa.invoice_id AND i.organization_id = ?
      WHERE pa.payment_id = ? AND (pa.deleted_at IS NULL OR ? = 1)
      ORDER BY pa.id ASC`,
    [orgId, id, voided ? 1 : 0],
  );
  const [[due]] = await db.query(
    `SELECT COALESCE(SUM(${OPEN_BALANCE_SQL}), 0) AS remaining
       FROM invoices i
      WHERE i.client_id = ? AND i.organization_id = ? AND i.deleted_at IS NULL AND i.status IN (${PAYABLE_IN})`,
    [p.client_id, orgId, ...PAYABLE_STATUSES],
  );
  let rfc = p.org_tax_id || null;
  if (p.org_locale === 'MX') {
    const [mx] = await db.query(
      'SELECT rfc, razon_social FROM organization_mx_profiles WHERE organization_id = ? AND deleted_at IS NULL LIMIT 1',
      [orgId],
    );
    if (mx && mx[0] && mx[0].rfc) rfc = mx[0].rfc;
  }
  let userName = null;
  if (p.recorded_by) {
    // Staff identities live in the primary database.
    const [users] = await runInPrimaryContext(() => db.query(
      `/* includes deleted rows: the receipt names the user who took the money, even if archived since */
       /* org-scoped by: recorded_by of a payment already bound to this organization and reseller; staff identities live in the primary database */
       SELECT first_name, last_name FROM users WHERE id = ? LIMIT 1`,
      [p.recorded_by],
    ));
    if (users && users[0]) userName = `${users[0].first_name || ''} ${users[0].last_name || ''}`.trim() || null;
  }

  const lang = p.org_locale === 'MX' ? 'es' : 'en';
  const ispName = p.org_legal_name || p.org_name || '';
  const resellerName = p.reseller_name || '';
  const address = [p.org_address, p.org_city, p.org_state].filter(Boolean).join(', ') || null;
  const client = { name: p.client_name, reseller_id: p.client_reseller_id };
  const out = {
    receipt_number: `PV-${String(id).padStart(6, '0')}`,
    issued_at: p.created_at,
    status: voided ? 'voided' : 'completed',
    isp: { name: ispName, rfc, address, phone: p.org_phone || null },
    collected_by: { reseller_name: resellerName, user_name: userName },
    client: { number: Number(p.client_id), name: displayName(scope, client), own: isOwn(scope, client) },
    amount: toMoney(p.amount),
    currency: p.currency,
    payment_method: 'cash',
    allocations: (allocs || []).map((a) => ({ invoice_number: a.invoice_number ?? null, amount: toMoney(a.amount) })),
    remaining_balance: toMoney(due?.remaining),
    legend: RECEIPT_TEXT[lang].legend(resellerName, ispName),
    language: lang,
  };
  out.plain_text = receiptPlainText({ ...out, issued_local: localStamp(p.created_at) }, width, lang);
  return out;
}

// -----------------------------------------------------------------------------
// Cash session (Mi caja)
// -----------------------------------------------------------------------------

function sessionTotalsSql() {
  // Net of voids: a void carries its collection's session and a negative amount.
  return `SELECT COALESCE(SUM(e.amount), 0) AS expected_total,
                 COALESCE(SUM(e.entry_type = 'collection'), 0) - COALESCE(SUM(e.entry_type = 'collection_void'), 0) AS collections_count
            FROM reseller_ledger_entries e
           WHERE e.organization_id = ? AND e.cash_session_id = ?
             AND e.entry_type IN ('collection', 'collection_void')`;
}

const nullableMoney = (v) => (v === null || v === undefined ? null : toMoney(v));

/** GET /reseller-app/cash-session: { current, recent }. */
async function cashSession(req) {
  const orgId = req.orgId;
  const userId = req.user.id;
  const [openRows] = await db.query(
    `SELECT id, opened_at FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId, userId],
  );
  let current = null;
  if (openRows && openRows[0]) {
    const [[totals]] = await db.query(sessionTotalsSql(), [orgId, openRows[0].id]);
    current = {
      id: Number(openRows[0].id),
      opened_at: openRows[0].opened_at,
      expected_total: toMoney(totals?.expected_total),
      collections_count: Number(totals?.collections_count) || 0,
    };
  }
  const [closed] = await db.query(
    `SELECT id, opened_at, closed_at, expected_total, counted_total, variance, status
       FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status <> 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 10`,
    [orgId, userId],
  );
  return {
    current,
    recent: (closed || []).map((s) => ({
      id: Number(s.id),
      opened_at: s.opened_at,
      closed_at: s.closed_at,
      expected_total: nullableMoney(s.expected_total),
      counted_total: nullableMoney(s.counted_total),
      variance: nullableMoney(s.variance),
      status: s.status,
    })),
  };
}

/**
 * POST /reseller-app/cash-session/close: close the caller's open session with
 * the cash it counted (cashReconciliationService.closeSession computes the
 * expected total and the variance). The ledger does not change: the cash is
 * still the reseller's to hand in.
 */
async function closeCashSession(req, { counted_total: counted, notes }) {
  const orgId = req.orgId;
  const userId = req.user.id;
  const [openRows] = await db.query(
    `SELECT id FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId, userId],
  );
  if (!openRows || !openRows[0]) throw new AppError('You have no open cash box to close.', 409, 'NO_OPEN_CASH_SESSION');
  const sessionId = Number(openRows[0].id);
  const cashReconciliationService = require('./cashReconciliationService');
  const closed = await cashReconciliationService.closeSession(sessionId, orgId, toMoney(counted));
  const text = typeof notes === 'string' && notes.trim() ? notes.trim() : null;
  if (text) {
    await db.query(
      'UPDATE cash_reconciliation_sessions SET notes = ? WHERE id = ? AND organization_id = ?',
      [text, sessionId, orgId],
    );
  }
  await afterCommit(() => auditLog.log({
    userId, organizationId: orgId, action: 'close', tableName: 'cash_reconciliation_sessions', recordId: sessionId,
    newValues: { expected_total: closed?.expected_total, counted_total: closed?.counted_total, variance: closed?.variance },
  }), 'audit log');
  return {
    id: sessionId,
    opened_at: closed?.opened_at ?? null,
    closed_at: closed?.closed_at ?? null,
    expected_total: nullableMoney(closed?.expected_total),
    counted_total: nullableMoney(closed?.counted_total),
    variance: nullableMoney(closed?.variance),
    status: closed?.status ?? 'closed',
  };
}

/** What the reseller collected on today's business day (live collections only). */
async function collectedToday(orgId, collectorId) {
  const today = businessToday();
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS total
       FROM payments p
      WHERE p.organization_id = ? AND p.reseller_id = ? AND p.status = 'completed' AND p.deleted_at IS NULL
        AND p.created_at >= ? AND p.created_at < ?`,
    [orgId, collectorId, businessDayStartUtc(today), businessDayStartUtc(addDays(today, 1))],
  );
  return toMoney(row?.total);
}

module.exports = {
  maskName,
  parseLookupQuery,
  phoneCandidates,
  lookup,
  targetForOwnClient,
  collect,
  voidCollection,
  listCollections,
  receipt,
  cashSession,
  closeCashSession,
  collectedToday,
  LOOKUP_LIMIT,
};
