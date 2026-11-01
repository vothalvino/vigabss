// =============================================================================
// Gateway payment reconciliation (BIL-05 / WHK-03)
// =============================================================================
// A succeeded gateway transaction must become a real payments row with its
// allocations, through the same allocation + ledger code a staff-recorded
// payment uses, exactly once, keeping any overpayment as client credit. Refunds
// reverse it, failed reconciles are retried (webhook redelivery + sweep).
//
// The database is a small stateful in-memory fake that understands the exact
// statements on this path (with transaction snapshots for rollback), so the
// assertions are about resulting rows, not about mock call order.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn((cb) => cb()),
  withTenantContext: jest.fn((_orgId, cb) => cb()),
}));

jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  mock.child = jest.fn(() => mock);
  return mock;
});

jest.mock('../src/services/suspensionService', () => ({
  reconnectContract: jest.fn(async () => ({})),
}));

jest.mock('../src/services/repService', () => ({
  maybeGenerateRep: jest.fn(async () => ({ generated: false, reason: 'NO_PPD_CFDI' })),
  FORMA_PAGO_BY_METHOD: jest.requireActual('../src/services/repService').FORMA_PAGO_BY_METHOD,
}));

const db = require('../src/config/database');
const suspensionService = require('../src/services/suspensionService');
const repService = require('../src/services/repService');
const paymentGatewayService = require('../src/services/paymentGatewayService');

const ORG = 42;
const CLIENT = 5;
const PAYABLE = ['issued', 'sent', 'overdue'];

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------
let state;
let failNext; // { re: RegExp } — the next matching statement throws once

function freshState() {
  return {
    seq: { payments: 1000, allocations: 2000, ledger: 3000, events: 4000 },
    gateways: [{ id: 7, organization_id: ORG, provider: 'stripe' }],
    transactions: [],
    invoices: [],
    payments: [],
    allocations: [],
    ledger: [],
    contracts: [],
    retries: [],
    events: [],
    chargebacks: [],
  };
}

function liveAllocated(invoiceId) {
  return state.allocations
    .filter((a) => a.invoice_id === invoiceId && !a.deleted_at)
    .reduce((s, a) => s + Number(a.amount), 0);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

async function run(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (failNext && failNext.re.test(s)) {
    failNext = null;
    throw new Error('simulated database failure');
  }
  const p = params;

  // --- payment_transactions ------------------------------------------------
  // The pre-read invoice lock (DAL-04): a pure locking read, nothing to return.
  if (/^SELECT id FROM invoices WHERE organization_id <=> \? AND \(/.test(s)) return [[]];
  if (/^SELECT \* FROM payment_transactions WHERE id = \? FOR UPDATE/.test(s)) {
    return [state.transactions.filter((t) => t.id === Number(p[0])).map(clone)];
  }
  if (/^SELECT \* FROM payment_transactions WHERE gateway_reference_id = \?/.test(s)) {
    return [state.transactions.filter((t) => t.gateway_reference_id === p[0]
      && (p[1] === undefined || t.organization_id === p[1])).map(clone)];
  }
  if (/^SELECT \* FROM payment_transactions WHERE id = \?/.test(s)) {
    return [state.transactions.filter((t) => t.id === Number(p[0])
      && (p[1] === undefined || t.organization_id === p[1])).map(clone)];
  }
  if (/^UPDATE payment_transactions SET gateway_status = \?, webhook_payload = \?, gateway_reference_id = COALESCE/.test(s)) {
    const t = state.transactions.find((x) => x.id === p[3]);
    t.gateway_status = p[0];
    t.webhook_payload = p[1];
    if (p[2]) t.gateway_reference_id = p[2];
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE payment_transactions SET payment_id = \? WHERE id = \?/.test(s)) {
    state.transactions.find((x) => x.id === p[1]).payment_id = p[0];
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE payment_transactions SET settled_invoice_id = \? WHERE id = \?/.test(s)) {
    state.transactions.find((x) => x.id === p[1]).settled_invoice_id = p[0];
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT pt\.id FROM payment_transactions pt WHERE pt\.organization_id = \?/.test(s)) {
    const legacy = new Set(state.ledger
      .filter((l) => l.reference_type === 'payment_transaction' && l.entry_type === 'credit')
      .map((l) => l.reference_id));
    return [state.transactions
      .filter((t) => t.organization_id === p[0] && t.gateway_status === 'succeeded'
        && !t.payment_id && !legacy.has(t.id))
      .map((t) => ({ id: t.id }))];
  }

  // --- gateways --------------------------------------------------------------
  if (/^SELECT provider FROM payment_gateways WHERE id = \? AND organization_id = \?/.test(s)) {
    return [state.gateways.filter((g) => g.id === p[0] && g.organization_id === p[1])];
  }

  // --- ledger ----------------------------------------------------------------
  if (/^SELECT id FROM client_balance_ledger WHERE reference_type = 'payment_transaction' AND reference_id = \? AND entry_type = '(credit|debit)'/.test(s)) {
    const type = s.match(/entry_type = '(credit|debit)'/)[1];
    return [state.ledger.filter((l) => l.reference_type === 'payment_transaction'
      && l.reference_id === p[0] && l.entry_type === type)];
  }
  if (/^INSERT INTO client_balance_ledger/.test(s)) {
    const type = /'debit'/.test(s) ? 'debit' : 'credit';
    const refType = s.match(/'(payment|payment_transaction)', \?/)[1];
    state.ledger.push({
      id: ++state.seq.ledger, client_id: p[0], organization_id: p[1], entry_type: type,
      amount: Number(p[2]), currency: p[3], reference_type: refType, reference_id: p[4],
    });
    return [{ insertId: state.seq.ledger }];
  }

  // --- invoices --------------------------------------------------------------
  if (/^SELECT i\.\*, \(i\.total - COALESCE/.test(s)) {
    const [clientId, orgId] = p;
    const ids = p.slice(2 + PAYABLE.length);
    const rows = state.invoices
      .filter((i) => i.client_id === clientId && i.organization_id === orgId && !i.deleted_at
        && PAYABLE.includes(i.status) && (ids.length === 0 || ids.includes(i.id)))
      .sort((a, b) => (a.issue_date < b.issue_date ? -1 : a.issue_date > b.issue_date ? 1 : a.id - b.id))
      .map((i) => ({ ...clone(i), balance_due: (Number(i.total) - liveAllocated(i.id)).toFixed(2) }));
    return [rows];
  }
  if (/^UPDATE invoices SET status = \?, paid_at = NOW\(\) WHERE id = \?/.test(s)) {
    const inv = state.invoices.find((i) => i.id === p[1]);
    inv.status = p[0];
    inv.paid_at = 'now';
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT i\.total, COALESCE/.test(s)) {
    const inv = state.invoices.find((i) => i.id === p[0]);
    return [inv ? [{ total: inv.total, allocated: liveAllocated(inv.id).toFixed(2) }] : []];
  }
  if (/^UPDATE invoices SET status = 'issued', paid_at = NULL WHERE id = \? AND status = 'paid'/.test(s)) {
    const inv = state.invoices.find((i) => i.id === p[0]);
    if (inv && inv.status === 'paid') { inv.status = 'issued'; inv.paid_at = null; }
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE invoices SET status = 'paid', paid_at = NOW\(\) WHERE id = \? AND status <> 'paid'/.test(s)) {
    const inv = state.invoices.find((i) => i.id === p[0]);
    if (inv) { inv.status = 'paid'; inv.paid_at = 'now'; }
    return [{ affectedRows: 1 }];
  }

  // --- payments + allocations -----------------------------------------------
  if (/^INSERT INTO payments/.test(s)) {
    const row = {
      id: ++state.seq.payments, organization_id: p[0], client_id: p[1], invoice_id: p[2],
      amount: String(p[3]), currency: p[4], payment_method: p[5], sat_forma_pago: p[6],
      reference_number: p[7], notes: p[8], status: 'completed', deleted_at: null,
    };
    state.payments.push(row);
    return [{ insertId: row.id }];
  }
  if (/^SELECT \* FROM payments WHERE id = \? AND organization_id <=> \? FOR UPDATE/.test(s)) {
    return [state.payments.filter((x) => x.id === p[0] && x.organization_id === p[1]).map(clone)];
  }
  if (/^UPDATE payments SET status = 'refunded' WHERE id = \?/.test(s)) {
    state.payments.find((x) => x.id === p[0]).status = 'refunded';
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO payment_allocations/.test(s)) {
    const dup = state.allocations.find((a) => a.payment_id === p[0] && a.invoice_id === p[1] && !a.deleted_at);
    if (dup) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
    const row = { id: ++state.seq.allocations, payment_id: p[0], invoice_id: p[1], amount: Number(p[2]), deleted_at: null };
    state.allocations.push(row);
    return [{ insertId: row.id }];
  }
  if (/^SELECT SUM\(amount\) AS total_allocated FROM payment_allocations WHERE invoice_id = \?/.test(s)) {
    return [[{ total_allocated: liveAllocated(p[0]).toFixed(2) }]];
  }
  if (/^SELECT DISTINCT invoice_id FROM payment_allocations WHERE payment_id = \? AND deleted_at IS NULL/.test(s)) {
    return [[...new Set(state.allocations.filter((a) => a.payment_id === p[0] && !a.deleted_at).map((a) => a.invoice_id))]
      .map((invoiceId) => ({ invoice_id: invoiceId }))];
  }
  if (/^UPDATE payment_allocations SET deleted_at = NOW\(\) WHERE payment_id = \?/.test(s)) {
    state.allocations.filter((a) => a.payment_id === p[0] && !a.deleted_at).forEach((a) => { a.deleted_at = 'now'; });
    return [{ affectedRows: 1 }];
  }

  // --- side effects ----------------------------------------------------------
  if (/^SELECT \* FROM contracts WHERE id = \?/.test(s)) {
    return [state.contracts.filter((c) => c.id === p[0] && c.organization_id === p[1]
      && c.client_id === p[2] && c.status === p[3])];
  }
  if (/^UPDATE payment_retries SET status = 'cancelled'/.test(s)) {
    const key = /AND invoice_id = \?/.test(s) ? 'invoice_id' : 'transaction_id';
    let n = 0;
    state.retries.filter((r) => r[key] === p[0] && ['pending', 'processing'].includes(r.status))
      .forEach((r) => { r.status = 'cancelled'; n += 1; });
    return [{ affectedRows: n }];
  }
  if (/^INSERT INTO chargebacks/.test(s)) {
    // UNIQUE(gateway_dispute_id): a second event for one dispute updates the row,
    // and only an outcome (not 'received') overwrites the status.
    const existing = state.chargebacks.find((c) => c.gateway_dispute_id === p[3]);
    if (existing) {
      if (p[7] !== 'received') existing.status = p[7];
      return [{ affectedRows: 2 }];
    }
    state.chargebacks.push({ organization_id: p[0], payment_id: p[1], gateway_dispute_id: p[3], reason_code: p[6], status: p[7] });
    return [{ affectedRows: 1 }];
  }

  // --- webhook_events --------------------------------------------------------
  if (/^SELECT id, status FROM webhook_events/.test(s)) {
    return [state.events.filter((e) => e.provider === p[0] && e.provider_event_id === p[1] && e.org_dedup === p[2])
      .map((e) => ({ id: e.id, status: e.status }))];
  }
  if (/^INSERT INTO webhook_events/.test(s)) {
    const row = { id: ++state.seq.events, organization_id: p[0], org_dedup: p[0] ?? 0, provider: p[1], provider_event_id: p[2], status: 'processing' };
    state.events.push(row);
    return [{ insertId: row.id }];
  }
  if (/^UPDATE webhook_events SET status = 'processing', error_message = NULL WHERE id = \? AND status = 'failed'/.test(s)) {
    const e = state.events.find((x) => x.id === p[0] && x.status === 'failed');
    if (e) e.status = 'processing';
    return [{ affectedRows: e ? 1 : 0 }];
  }
  if (/^UPDATE webhook_events SET/.test(s)) {
    const id = p[p.length - 1];
    const e = state.events.find((x) => x.id === id);
    const m = s.match(/status = '(\w+)'/);
    if (e && m) e.status = m[1];
    return [{ affectedRows: 1 }];
  }

  // --- organizations (sweep fan-out) -----------------------------------------
  if (/FROM organizations o LEFT JOIN organization_database_configs/.test(s)) {
    return [[{ id: ORG, database_scope: 'shared' }]];
  }

  throw new Error(`fake db: unhandled SQL: ${s.slice(0, 140)}`);
}

function makeConn() {
  let snapshot = null;
  return {
    beginTransaction: jest.fn(async () => { snapshot = clone(state); }),
    commit: jest.fn(async () => { snapshot = null; }),
    rollback: jest.fn(async () => { if (snapshot) { state = snapshot; snapshot = null; } }),
    release: jest.fn(),
    execute: jest.fn((sql, params) => run(sql, params)),
    query: jest.fn((sql, params) => run(sql, params)),
  };
}

function addInvoice(over) {
  const row = {
    id: over.id, organization_id: ORG, client_id: CLIENT, status: 'issued', total: '500.00',
    currency: 'MXN', issue_date: '2026-09-01', contract_id: null, deleted_at: null, invoice_number: `INV-${over.id}`,
    ...over,
  };
  state.invoices.push(row);
  return row;
}

function addTx(over) {
  const row = {
    id: over.id, organization_id: ORG, client_id: CLIENT, payment_gateway_id: 7, payment_id: null,
    invoice_id: null, settled_invoice_id: null, amount: '500.00', currency: 'MXN',
    gateway_reference_id: `pi_${over.id}`, gateway_status: 'succeeded', webhook_payload: null,
    ...over,
  };
  state.transactions.push(row);
  return row;
}

const paymentsFor = (txId) => state.payments.filter((pay) => state.transactions.find((t) => t.id === txId)?.payment_id === pay.id);

beforeEach(() => {
  jest.clearAllMocks();
  state = freshState();
  failNext = null;
  db.query.mockImplementation((sql, params) => run(sql, params));
  db.getConnection.mockImplementation(async () => makeConn());
});

// =============================================================================
describe('reconcilePayment() posts a real payment', () => {
  test('creates a completed payment, links payment_id, credits the ledger and allocates the linked invoice', async () => {
    addInvoice({ id: 77, total: '500.00' });
    addTx({ id: 1, invoice_id: 77, amount: '500.00', gateway_reference_id: 'pi_abc' });

    const res = await paymentGatewayService.reconcilePayment(1);

    expect(res.status).toBe('reconciled');
    expect(state.payments).toHaveLength(1);
    const pay = state.payments[0];
    expect(pay).toMatchObject({
      organization_id: ORG, client_id: CLIENT, invoice_id: 77, amount: '500.00', currency: 'MXN',
      status: 'completed', payment_method: 'card', sat_forma_pago: '04', reference_number: 'pi_abc',
    });
    // The orchestrator's autopay "charge in flight" guard relies on this link.
    expect(state.transactions[0].payment_id).toBe(pay.id);
    expect(state.ledger).toEqual([expect.objectContaining({
      entry_type: 'credit', reference_type: 'payment', reference_id: pay.id, amount: 500,
    })]);
    expect(state.allocations).toEqual([expect.objectContaining({ payment_id: pay.id, invoice_id: 77, amount: 500 })]);
    expect(state.invoices[0]).toMatchObject({ status: 'paid', paid_at: 'now' });
    expect(state.transactions[0].settled_invoice_id).toBe(77);
    expect(repService.maybeGenerateRep).toHaveBeenCalledWith(pay.id, 77, 500, ORG, null);
  });

  test('an overdue linked invoice is settled too', async () => {
    addInvoice({ id: 78, status: 'overdue', total: '300.00' });
    addTx({ id: 2, invoice_id: 78, amount: '300.00' });
    await paymentGatewayService.reconcilePayment(2);
    expect(state.invoices[0].status).toBe('paid');
  });

  test('an overpayment of a partly-paid invoice keeps the remainder as client credit', async () => {
    addInvoice({ id: 80, total: '500.00' });
    state.allocations.push({ id: 1, payment_id: 900, invoice_id: 80, amount: 200, deleted_at: null }); // cash already paid 200
    addTx({ id: 3, invoice_id: 80, amount: '500.00' }); // checkout charged the full total

    const res = await paymentGatewayService.reconcilePayment(3);

    expect(res.remainingCredit).toBe(200);
    const pay = state.payments[0];
    expect(pay.amount).toBe('500.00');
    expect(state.allocations.filter((a) => a.payment_id === pay.id)).toEqual([expect.objectContaining({ amount: 300 })]);
    expect(state.invoices[0].status).toBe('paid');
    // Full amount is credited, so the unallocated 200 stays as standing credit.
    expect(state.ledger[0].amount).toBe(500);
  });

  test('a linked invoice that was already settled leaves the whole capture as credit (no FIFO surprise)', async () => {
    addInvoice({ id: 81, status: 'paid' });
    addInvoice({ id: 82, total: '100.00' });
    addTx({ id: 4, invoice_id: 81, amount: '500.00' });

    const res = await paymentGatewayService.reconcilePayment(4);

    expect(res.status).toBe('reconciled');
    expect(state.payments[0].invoice_id).toBeNull();
    expect(state.allocations).toHaveLength(0);
    expect(res.remainingCredit).toBe(500);
    expect(state.invoices.find((i) => i.id === 82).status).toBe('issued');
  });

  test('an unlinked capture (legacy autopay) is applied FIFO oldest-first across payable invoices', async () => {
    addInvoice({ id: 90, total: '200.00', issue_date: '2026-07-01' });
    addInvoice({ id: 91, total: '200.00', issue_date: '2026-08-01' });
    addInvoice({ id: 92, total: '200.00', issue_date: '2026-09-01' });
    addTx({ id: 5, amount: '300.00' });

    await paymentGatewayService.reconcilePayment(5);

    expect(state.allocations.map((a) => [a.invoice_id, a.amount])).toEqual([[90, 200], [91, 100]]);
    expect(state.invoices.map((i) => i.status)).toEqual(['paid', 'issued', 'issued']);
  });

  test('never touches another organization\'s invoices', async () => {
    addInvoice({ id: 95, organization_id: 99, total: '500.00' });
    addTx({ id: 6, amount: '500.00' });
    await paymentGatewayService.reconcilePayment(6);
    expect(state.allocations).toHaveLength(0);
    expect(state.invoices[0].status).toBe('issued');
    expect(state.payments[0].organization_id).toBe(ORG);
  });

  test('reconnects a suspended contract of the paid invoice and cancels its pending charge retries', async () => {
    addInvoice({ id: 70, contract_id: 300 });
    state.contracts.push({ id: 300, organization_id: ORG, client_id: CLIENT, status: 'suspended' });
    state.retries.push({ id: 1, invoice_id: 70, status: 'pending' });
    addTx({ id: 7, invoice_id: 70 });

    await paymentGatewayService.reconcilePayment(7);

    expect(suspensionService.reconnectContract).toHaveBeenCalledWith(300, null, 70, { orgId: ORG });
    expect(state.retries[0].status).toBe('cancelled');
  });

  test('maps the Conekta payment method (OXXO cash, SPEI, debit) for the REP forma de pago', async () => {
    state.gateways.push({ id: 8, organization_id: ORG, provider: 'conekta' });
    const cases = [
      [{ type: 'oxxo', object: 'cash_payment' }, 'oxxo_pay', '01'],
      [{ type: 'spei', object: 'bank_transfer_payment' }, 'spei', '03'],
      [{ type: 'debit', object: 'card_payment' }, 'debit_card', '28'],
      [{ type: 'credit', object: 'card_payment' }, 'credit_card', '04'],
    ];
    let id = 20;
    for (const [pm, method, forma] of cases) {
      id += 1;
      addTx({
        id, payment_gateway_id: 8,
        webhook_payload: JSON.stringify({ data: { object: { id: `ord_${id}`, charges: { data: [{ payment_method: pm }] } } } }),
      });
      await paymentGatewayService.reconcilePayment(id);
      expect(paymentsFor(id)[0]).toMatchObject({ payment_method: method, sat_forma_pago: forma });
    }
  });

  test('is idempotent: a second reconcile of the same transaction posts nothing', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77 });
    await paymentGatewayService.reconcilePayment(1);
    const again = await paymentGatewayService.reconcilePayment(1);
    expect(again).toEqual({ status: 'already_reconciled', paymentId: state.payments[0].id });
    expect(state.payments).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.allocations).toHaveLength(1);
  });

  test('skips a transaction reconciled by the pre-472 code (legacy payment_transaction credit)', async () => {
    addTx({ id: 9 });
    state.ledger.push({ id: 1, reference_type: 'payment_transaction', reference_id: 9, entry_type: 'credit', amount: 500 });
    const res = await paymentGatewayService.reconcilePayment(9);
    expect(res.status).toBe('legacy_reconciled');
    expect(state.payments).toHaveLength(0);
  });

  test('does nothing for a transaction that has not succeeded', async () => {
    addTx({ id: 10, gateway_status: 'pending' });
    expect((await paymentGatewayService.reconcilePayment(10)).status).toBe('not_succeeded');
    expect(state.payments).toHaveLength(0);
  });

  test('a failure rolls everything back and throws (so the caller can retry)', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77 });
    failNext = { re: /^INSERT INTO payment_allocations/ };

    await expect(paymentGatewayService.reconcilePayment(1)).rejects.toThrow('simulated database failure');

    expect(state.payments).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
    expect(state.transactions[0].payment_id).toBeNull();
    expect(state.invoices[0].status).toBe('issued');
  });
});

// =============================================================================
describe('webhook reconciliation is exactly-once and retryable', () => {
  const stripeEvent = (id, type, object) => ({
    provider: 'stripe', providerEventId: id, eventType: type, organizationId: ORG,
    payload: { id, type, data: { object } },
  });

  test('checkout.session.completed and the follow-up payment_intent.succeeded post ONE payment; the pi_ id is stored', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77, gateway_status: 'pending', gateway_reference_id: 'cs_test_1' });

    const r1 = await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_1', 'checkout.session.completed', {
      id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { transaction_id: '1' },
    }));
    expect(r1).toMatchObject({ status: 'processed', reconciliation: 'reconciled' });
    expect(state.transactions[0].gateway_reference_id).toBe('pi_test_1');

    // The PaymentIntent event matches by the stored pi_ id now (and by
    // payment_intent_data metadata otherwise) and is a no-op.
    const r2 = await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_2', 'payment_intent.succeeded', {
      id: 'pi_test_1', metadata: { transaction_id: '1' },
    }));
    expect(r2).toMatchObject({ status: 'processed', reconciliation: 'already_reconciled' });

    // A plain redelivery of the first event is a duplicate.
    expect((await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_1', 'checkout.session.completed', {
      id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_test_1',
    }))).status).toBe('duplicate');

    expect(state.payments).toHaveLength(1);
    expect(state.allocations).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
  });

  test('a payment_intent.succeeded with only PaymentIntent metadata still finds the checkout transaction', async () => {
    addTx({ id: 1, gateway_status: 'pending', gateway_reference_id: 'cs_only' });
    const r = await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_pi', 'payment_intent.succeeded', {
      id: 'pi_unknown', metadata: { transaction_id: '1' },
    }));
    expect(r.status).toBe('processed');
    expect(state.payments).toHaveLength(1);
  });

  test('a failed reconcile marks the event failed and throws; the provider redelivery retries and posts once', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77, gateway_status: 'pending', gateway_reference_id: 'cs_r' });
    const event = stripeEvent('evt_r', 'checkout.session.completed', { id: 'cs_r', payment_status: 'paid' });

    failNext = { re: /^INSERT INTO payments/ };
    await expect(paymentGatewayService.handleWebhookEvent(event)).rejects.toThrow('simulated database failure');
    expect(state.events[0].status).toBe('failed');
    expect(state.payments).toHaveLength(0);

    const retry = await paymentGatewayService.handleWebhookEvent(event);
    expect(retry).toMatchObject({ status: 'processed', reconciliation: 'reconciled' });
    expect(state.events).toHaveLength(1);
    expect(state.events[0].status).toBe('processed');
    expect(state.payments).toHaveLength(1);
  });

  test('a late payment_failed never demotes a captured payment', async () => {
    addTx({ id: 1, gateway_status: 'succeeded', gateway_reference_id: 'pi_late', payment_id: 555 });
    const r = await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_late', 'payment_intent.payment_failed', { id: 'pi_late' }));
    expect(r).toMatchObject({ status: 'ignored', reason: 'stale_transition' });
    expect(state.transactions[0].gateway_status).toBe('succeeded');
  });

  test('a dispute links the chargeback to the PAYMENT id, not the transaction id', async () => {
    addTx({ id: 1, gateway_reference_id: 'pi_d', payment_id: 555 });
    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_d', 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_d' }));
    expect(state.chargebacks).toEqual([expect.objectContaining({ payment_id: 555 })]);
  });

  // BIL-15: the chargeback stored the PaymentIntent as its dispute id, and a
  // lost dispute never reversed the settlement, so the subscriber stayed paid
  // after the money went back to the cardholder.
  test('a dispute stores the provider\'s dispute id', async () => {
    addTx({ id: 1, gateway_reference_id: 'pi_d', payment_id: 555 });
    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_d', 'charge.dispute.created', { id: 'du_1', payment_intent: 'pi_d', reason: 'fraudulent' }));
    expect(state.chargebacks).toEqual([expect.objectContaining({ gateway_dispute_id: 'du_1', reason_code: 'fraudulent', status: 'received' })]);
  });

  test('a lost dispute reverses the settlement and closes the chargeback as lost', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77, gateway_status: 'pending', gateway_reference_id: 'pi_l' });
    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_s', 'payment_intent.succeeded', { id: 'pi_l' }));
    expect(state.invoices[0].status).toBe('paid');

    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_c', 'charge.dispute.created', { id: 'du_2', payment_intent: 'pi_l', status: 'needs_response' }));
    expect(state.invoices[0].status).toBe('paid');
    const r = await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_x', 'charge.dispute.closed', { id: 'du_2', payment_intent: 'pi_l', status: 'lost' }));

    expect(r).toMatchObject({ status: 'processed', newStatus: 'refunded' });
    expect(state.transactions[0].gateway_status).toBe('refunded');
    expect(state.payments[0].status).toBe('refunded');
    expect(state.invoices[0]).toMatchObject({ status: 'issued', paid_at: null });
    expect(state.chargebacks).toEqual([expect.objectContaining({ gateway_dispute_id: 'du_2', status: 'lost' })]);
  });

  test('a won dispute keeps the payment and records the outcome', async () => {
    addInvoice({ id: 77, status: 'paid' });
    addTx({ id: 1, invoice_id: 77, gateway_status: 'disputed', gateway_reference_id: 'pi_w', payment_id: 555 });
    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_c', 'charge.dispute.created', { id: 'du_3', payment_intent: 'pi_w' }));
    await paymentGatewayService.handleWebhookEvent(stripeEvent('evt_w', 'charge.dispute.closed', { id: 'du_3', payment_intent: 'pi_w', status: 'won' }));
    expect(state.transactions[0].gateway_status).toBe('disputed');
    expect(state.invoices[0].status).toBe('paid');
    expect(state.chargebacks).toEqual([expect.objectContaining({ gateway_dispute_id: 'du_3', status: 'won' })]);
  });

  test('a Conekta charge.refunded matches the order through charge.order_id', async () => {
    state.gateways.push({ id: 8, organization_id: ORG, provider: 'conekta' });
    addInvoice({ id: 77 });
    addTx({ id: 1, payment_gateway_id: 8, invoice_id: 77, gateway_reference_id: 'ord_abc' });
    await paymentGatewayService.reconcilePayment(1);

    const r = await paymentGatewayService.handleWebhookEvent({
      provider: 'conekta', providerEventId: 'evt_cr', eventType: 'charge.refunded', organizationId: ORG,
      payload: { id: 'evt_cr', type: 'charge.refunded', data: { object: { id: '6123charge', order_id: 'ord_abc' } } },
    });
    expect(r).toMatchObject({ status: 'processed', newStatus: 'refunded' });
    expect(state.payments[0].status).toBe('refunded');
  });
});

// =============================================================================
describe('refund reversal of a reconciled gateway payment', () => {
  test('refunds the payment, releases its allocations, re-opens the invoice and offsets the credit — once', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77 });
    await paymentGatewayService.reconcilePayment(1);
    state.transactions[0].gateway_status = 'refunded';

    await paymentGatewayService.reverseRefund(1);
    await paymentGatewayService.reverseRefund(1); // refund() + charge.refunded double fire

    expect(state.payments[0].status).toBe('refunded');
    expect(state.allocations.every((a) => a.deleted_at)).toBe(true);
    expect(state.invoices[0]).toMatchObject({ status: 'issued', paid_at: null });
    const net = state.ledger.reduce((s, l) => s + (l.entry_type === 'credit' ? l.amount : -l.amount), 0);
    expect(net).toBe(0);
    expect(state.ledger.filter((l) => l.entry_type === 'debit')).toHaveLength(1);
  });

  // WHK-05: one provider account registered on both the env route (no org) and
  // the per-gateway URL dedups each delivery separately, so the same event is
  // processed twice. An unlinked (retry) capture used to settle a second
  // invoice on the second pass.
  test('the same event delivered to both endpoints posts one payment and settles one invoice', async () => {
    addInvoice({ id: 900, issue_date: '2026-08-01' });
    addInvoice({ id: 901, issue_date: '2026-09-01' });
    addTx({ id: 1, gateway_status: 'pending', gateway_reference_id: 'pi_dual', amount: '500.00' });
    const event = (organizationId) => ({
      provider: 'stripe', providerEventId: 'evt_dual', eventType: 'payment_intent.succeeded', organizationId,
      payload: { id: 'evt_dual', type: 'payment_intent.succeeded', data: { object: { id: 'pi_dual' } } },
    });

    const perGateway = await paymentGatewayService.handleWebhookEvent(event(ORG));
    const envRoute = await paymentGatewayService.handleWebhookEvent(event(null));

    expect(perGateway).toMatchObject({ status: 'processed', reconciliation: 'reconciled' });
    expect(envRoute.reconciliation).toBe('already_reconciled');
    expect(state.payments).toHaveLength(1);
    expect(state.ledger.filter((l) => l.entry_type === 'credit')).toHaveLength(1);
    expect(state.invoices.map((i) => [i.id, i.status])).toEqual([[900, 'paid'], [901, 'issued']]);
    expect(state.transactions[0].settled_invoice_id).toBe(900);
  });

  test('a refund after a reconciled event can never be resurrected by a redelivered success', async () => {
    addTx({ id: 1, gateway_status: 'refunded', gateway_reference_id: 'pi_x', payment_id: 555 });
    const r = await paymentGatewayService.handleWebhookEvent({
      provider: 'stripe', providerEventId: 'evt_x', eventType: 'payment_intent.succeeded', organizationId: ORG,
      payload: { id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } },
    });
    expect(r.reason).toBe('stale_transition');
    expect(state.transactions[0].gateway_status).toBe('refunded');
  });
});

// =============================================================================
describe('reconcileOutstandingTransactions() — retry sweep', () => {
  test('reconciles succeeded transactions without a payment, skipping legacy and already-linked ones', async () => {
    addInvoice({ id: 77 });
    addTx({ id: 1, invoice_id: 77 });                 // failed earlier: no payment yet
    addTx({ id: 2, payment_id: 999 });                // already reconciled
    addTx({ id: 3 });                                 // legacy-reconciled
    state.ledger.push({ id: 1, reference_type: 'payment_transaction', reference_id: 3, entry_type: 'credit', amount: 500 });
    addTx({ id: 4, gateway_status: 'pending' });      // not captured

    const summary = await paymentGatewayService.reconcileOutstandingTransactions(null);

    expect(summary).toMatchObject({ organizations_total: 1, candidates: 1, reconciled: 1, failed: 0 });
    expect(state.transactions.find((t) => t.id === 1).payment_id).toBe(state.payments[0].id);
    expect(state.payments).toHaveLength(1);

    // Running again finds nothing to do.
    const again = await paymentGatewayService.reconcileOutstandingTransactions(ORG);
    expect(again).toMatchObject({ candidates: 0, reconciled: 0 });
  });

  test('counts a still-failing transaction without aborting the sweep', async () => {
    addTx({ id: 1 });
    addTx({ id: 2 });
    failNext = { re: /^INSERT INTO payments/ };
    const summary = await paymentGatewayService.reconcileOutstandingTransactions(ORG);
    expect(summary).toMatchObject({ candidates: 2, reconciled: 1, failed: 1 });
    expect(summary.failures[0]).toMatchObject({ transaction_id: 1 });
  });

  test('is dispatched by the reconcile_gateway_payments scheduled task', () => {
    const taskRunner = require('../src/services/taskRunner');
    expect(taskRunner.ORGANIZATION_SCOPED_TASK_NAMES.has('reconcile_gateway_payments')).toBe(true);
  });
});
