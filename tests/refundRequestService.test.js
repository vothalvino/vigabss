// =============================================================================
// VigaBSS 5.0 — Refund Request Service Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
}));

jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn(),
  on: jest.fn(),
}));

jest.mock('../src/services/billingAdjustmentService', () => ({
  record: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../src/services/paymentGatewayService', () => ({
  refund: jest.fn(),
}));

jest.mock('../src/utils/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

const db = require('../src/config/database');
const eventBus = require('../src/services/eventBus');
const billingAdjustmentService = require('../src/services/billingAdjustmentService');
const paymentGatewayService = require('../src/services/paymentGatewayService');
const refundRequestService = require('../src/services/refundRequestService');

const MOCK_REQUEST = {
  id: 10,
  organization_id: 1,
  client_id: 5,
  payment_id: 20,
  invoice_id: 30,
  amount: '150.00',
  reason: 'overcharge',
  status: 'requested',
  requested_by: 2,
  reviewed_by: null,
  review_notes: null,
  processed_at: null,
  refund_method: null,
  gateway_refund_reference: null,
  resulting_credit_note_id: null,
};

beforeEach(() => {
  jest.resetAllMocks();
});

// =============================================================================
// createRequest
// =============================================================================
// Ownership lookups bind the caller org (and client); the mock answers them
// only for org 1 / client 5, the way a shared multi-org database would.
function wireOwnership({ client = true, invoice = true, tx = true } = {}) {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM clients WHERE id = \? AND organization_id <=> \?/.test(sql)) {
      return [client && params[1] === 1 ? [{ id: params[0] }] : []];
    }
    if (/FROM invoices[\s\S]*organization_id <=> \? AND client_id = \?/.test(sql)) {
      return [invoice && params[1] === 1 && params[2] === 5 ? [{ id: params[0] }] : []];
    }
    if (/FROM payment_transactions WHERE id = \? AND organization_id <=> \? AND client_id = \?/.test(sql)) {
      return [tx && params[1] === 1 && params[2] === 5 ? [{ id: params[0] }] : []];
    }
    if (/^INSERT INTO/i.test(sql)) return [{ insertId: 10 }];
    if (/FROM `?refund_requests`?/.test(sql)) return [[MOCK_REQUEST]];
    if (/^UPDATE `?refund_requests`?/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}
const inserted = () => db.query.mock.calls.some(([sql]) => /^INSERT INTO/i.test(sql));

describe('createRequest', () => {
  test('creates a row and emits refund.requested', async () => {
    wireOwnership();

    const result = await refundRequestService.createRequest(1, {
      client_id: 5,
      payment_id: 20,
      invoice_id: 30,
      amount: 150,
      reason: 'overcharge',
    }, 2);

    expect(result).toMatchObject({ id: 10, status: 'requested' });
    expect(eventBus.emit).toHaveBeenCalledWith('refund.requested', expect.objectContaining({
      organizationId: 1,
      refundRequest: expect.objectContaining({ id: 10 }),
    }));
  });

  test('rejects a client from another organization (422, nothing written)', async () => {
    wireOwnership();
    await expect(refundRequestService.createRequest(2, { client_id: 5, amount: 1, reason: 'other' }, 2))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(inserted()).toBe(false);
  });

  test("rejects another organization's or another client's payment transaction", async () => {
    wireOwnership({ tx: false });
    await expect(refundRequestService.createRequest(1, {
      client_id: 5, payment_id: 999, amount: 1, reason: 'other',
    }, 2)).rejects.toThrow(/payment_id/);
    expect(inserted()).toBe(false);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  test("rejects another client's invoice", async () => {
    wireOwnership({ invoice: false });
    await expect(refundRequestService.createRequest(1, {
      client_id: 5, invoice_id: 31, amount: 1, reason: 'other',
    }, 2)).rejects.toThrow(/invoice_id/);
    expect(inserted()).toBe(false);
  });
});

// =============================================================================
// updateRequest
// =============================================================================
describe('updateRequest', () => {
  test('writes only editable fields', async () => {
    wireOwnership();
    await refundRequestService.updateRequest(1, 10, {
      amount: 120, status: 'processed', reviewed_by: 99, refund_method: 'original_method',
    });
    const update = db.query.mock.calls.find(([sql]) => /^UPDATE `?refund_requests`?/i.test(sql));
    expect(update[0]).toMatch(/amount/);
    expect(update[0]).not.toMatch(/status|reviewed_by|refund_method/);
  });

  test('rejects a payment transaction that is not the client\'s', async () => {
    wireOwnership({ tx: false });
    await expect(refundRequestService.updateRequest(1, 10, { payment_id: 999 }))
      .rejects.toThrow(/payment_id/);
    expect(db.query.mock.calls.some(([sql]) => /^UPDATE/i.test(sql))).toBe(false);
  });

  test('refuses edits once the request is approved', async () => {
    wireOwnership();
    db.query.mockImplementation(async (sql) => (
      /FROM `?refund_requests`?/.test(sql) ? [[{ ...MOCK_REQUEST, status: 'approved' }]] : [[]]
    ));
    await expect(refundRequestService.updateRequest(1, 10, { amount: 1 }))
      .rejects.toThrow(/Cannot edit/);
  });
});

// =============================================================================
// reviewRequest
// =============================================================================
describe('reviewRequest', () => {
  test('approves a requested refund request', async () => {
    const approved = { ...MOCK_REQUEST, status: 'approved', reviewed_by: 3 };

    db.query
      .mockResolvedValueOnce([[MOCK_REQUEST]])   // findById
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[approved]]);       // SELECT after update

    const result = await refundRequestService.reviewRequest(1, 10, { status: 'approved', review_notes: 'OK' }, 3);
    expect(result).toMatchObject({ status: 'approved' });
  });

  test('rejects when status is already processed', async () => {
    db.query.mockResolvedValueOnce([[{ ...MOCK_REQUEST, status: 'processed' }]]);

    await expect(
      refundRequestService.reviewRequest(1, 10, { status: 'approved' }, 3),
    ).rejects.toThrow(/Cannot review/);
  });

  test('rejects an invalid review status', async () => {
    db.query.mockResolvedValueOnce([[MOCK_REQUEST]]);

    await expect(
      refundRequestService.reviewRequest(1, 10, { status: 'processed' }, 3),
    ).rejects.toThrow(/approved.*rejected/);
  });
});

// =============================================================================
// processRequest
// =============================================================================
describe('processRequest', () => {
  const approved = { ...MOCK_REQUEST, status: 'approved' };
  const claimSql = /^UPDATE refund_requests SET status = 'processed'/;
  const releaseSql = /^UPDATE refund_requests SET status = 'approved'/;

  function wireProcess({ claimed = true, request = approved, failOn = null } = {}) {
    db.query.mockImplementation(async (sql) => {
      if (failOn && failOn.test(sql)) throw new Error('db write failed');
      if (claimSql.test(sql)) return [{ affectedRows: claimed ? 1 : 0 }];
      if (releaseSql.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM `?refund_requests`?/.test(sql)) return [[request]];
      if (/FROM clients/.test(sql)) return [[{ id: 5 }]];
      if (/FROM payment_transactions/.test(sql)) return [[{ amount: '150.00' }]];
      if (/^UPDATE|^INSERT/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
      return [[]];
    });
  }
  const ran = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

  test('processes via credit_balance and emits refund.processed', async () => {
    wireProcess();

    const result = await refundRequestService.processRequest(1, 10, { refund_method: 'credit_balance' }, 3);
    expect(result).toMatchObject({ id: 10 });
    expect(billingAdjustmentService.record).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('refund.processed', expect.objectContaining({
      organizationId: 1,
    }));
    // The claim binds the caller org and the approved state.
    expect(ran(claimSql)[0][1]).toEqual([10, 1]);
    expect(ran(claimSql)[0][0]).toMatch(/organization_id <=> \? AND status = 'approved'/);
    // The payment_transactions lookup is org + client scoped.
    const [, txParams] = ran(/FROM payment_transactions/)[0];
    expect(txParams).toEqual([20, 1, 5]);
    expect(ran(releaseSql)).toHaveLength(0);
  });

  test('rejects when status is not approved', async () => {
    wireProcess({ claimed: false, request: MOCK_REQUEST }); // status: 'requested'

    await expect(
      refundRequestService.processRequest(1, 10, { refund_method: 'credit_balance' }, 3),
    ).rejects.toThrow(/Cannot process/);
    expect(billingAdjustmentService.record).not.toHaveBeenCalled();
  });

  test('a second, concurrent process call loses the claim and never refunds', async () => {
    wireProcess({ claimed: false, request: { ...approved, status: 'processed' } });

    await expect(
      refundRequestService.processRequest(1, 10, { refund_method: 'original_method' }, 3),
    ).rejects.toThrow(/status 'processed'/);
    expect(paymentGatewayService.refund).not.toHaveBeenCalled();
  });

  test('another organization cannot process the request (404)', async () => {
    wireProcess({ claimed: false });
    db.query.mockImplementation(async (sql) => (claimSql.test(sql) ? [{ affectedRows: 0 }] : [[]]));

    await expect(
      refundRequestService.processRequest(2, 10, { refund_method: 'original_method' }, 3),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(paymentGatewayService.refund).not.toHaveBeenCalled();
  });

  test('original_method refunds the requested amount within the org and client', async () => {
    wireProcess();
    paymentGatewayService.refund.mockResolvedValue({ status: 'refunded', gateway_refund_reference: 're_1' });

    await refundRequestService.processRequest(1, 10, { refund_method: 'original_method' }, 3);
    expect(paymentGatewayService.refund).toHaveBeenCalledWith(20, { orgId: 1, clientId: 5, amount: '150.00' });
  });

  test('a gateway failure releases the claim so the request stays approved', async () => {
    wireProcess();
    paymentGatewayService.refund.mockRejectedValue(new Error('Partial gateway refunds are not supported yet'));

    await expect(
      refundRequestService.processRequest(1, 10, { refund_method: 'original_method' }, 3),
    ).rejects.toThrow(/Partial gateway refunds/);
    expect(ran(releaseSql)).toHaveLength(1);
    expect(billingAdjustmentService.record).not.toHaveBeenCalled();
  });

  test('after the gateway refunded, a bookkeeping failure never re-opens the request', async () => {
    wireProcess();
    paymentGatewayService.refund.mockResolvedValue({ status: 'refunded' });
    billingAdjustmentService.record.mockRejectedValue(new Error('adjustment insert failed'));

    await expect(
      refundRequestService.processRequest(1, 10, { refund_method: 'original_method' }, 3),
    ).rejects.toThrow(/adjustment insert failed/);
    expect(ran(releaseSql)).toHaveLength(0);
  });
});
