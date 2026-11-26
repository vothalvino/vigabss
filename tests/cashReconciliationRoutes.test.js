// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Route Integration Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/models/User');

jest.mock('../src/services/cashReconciliationService', () => ({
  openSession: jest.fn(),
  closeSession: jest.fn(),
  approveSession: jest.fn(),
  disputeSession: jest.fn(),
  addStaffNames: jest.fn(),
  listPickups: jest.fn(),
  openingExpectation: jest.fn(),
  rules: jest.fn(),
  setPickupRules: jest.fn(),
  createPickup: jest.fn(),
  confirmPickup: jest.fn(),
  cancelPickup: jest.fn(),
  assertMayTakeCash: jest.fn(),
  getSessionDetail: jest.fn(),
  myOpenSession: jest.fn(),
  attention: jest.fn(),
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

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const cashReconciliationService = require('../src/services/cashReconciliationService');
const app = require('../src/app');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 1, email: 'test@example.com', role: 'admin', orgId: 1, ...payload },
    config.jwt.secret,
    { expiresIn: '1h' },
  );
}

const authToken = makeToken();

function mockAuthUser() {
  User.findById.mockResolvedValue({
    id: 1,
    email: 'test@example.com',
    status: 'active',
    role: 'admin',
    organization_id: 1,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

// =============================================================================
// POST /api/v1/cash-reconciliation/sessions
// =============================================================================
describe('POST /api/v1/cash-reconciliation/sessions', () => {
  test('returns 201 with created session', async () => {
    mockAuthUser();

    const newSession = {
      id: 1,
      organization_id: 1,
      agent_user_id: 1,
      status: 'open',
      notes: null,
    };

    cashReconciliationService.openSession.mockResolvedValueOnce(newSession);

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ opening_total: 500 });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.status).toBe('open');
    expect(cashReconciliationService.openSession).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 1,
        agentUserId: 1,
        openingTotal: 500,
      }),
    );
  });

  test('passes notes to service', async () => {
    mockAuthUser();

    cashReconciliationService.openSession.mockResolvedValueOnce({
      id: 2,
      status: 'open',
      notes: 'Morning shift',
    });

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'Morning shift', opening_total: 500 });

    expect(res.status).toBe(201);
    expect(cashReconciliationService.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'Morning shift' }),
    );
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions')
      .send({ opening_total: 500 });

    expect(res.status).toBe(401);
  });

  test('returns 422 when agent already has an open session', async () => {
    mockAuthUser();

    const { ValidationError } = require('../src/utils/errors');
    cashReconciliationService.openSession.mockRejectedValueOnce(
      new ValidationError('Agent already has an open reconciliation session'),
    );

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ opening_total: 500 });

    expect(res.status).toBe(422);
  });
});

// =============================================================================
// GET /api/v1/cash-reconciliation/sessions
// =============================================================================
describe('GET /api/v1/cash-reconciliation/sessions', () => {
  test('returns 200 with list of sessions', async () => {
    mockAuthUser();

    const mockSession = {
      id: 1,
      organization_id: 1,
      agent_user_id: 1,
      status: 'closed',
    };

    db.query
      .mockResolvedValueOnce([[mockSession]])      // findAll
      .mockResolvedValueOnce([[{ total: 1 }]]);    // count
    // The rows are named before they are sent.
    cashReconciliationService.addStaffNames.mockImplementation(async (rows) => {
      for (const row of rows) row.agent_name = 'Ana Ruiz';
    });

    const res = await request(app)
      .get('/api/v1/cash-reconciliation/sessions')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.body.data[0].agent_name).toBe('Ana Ruiz');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/v1/cash-reconciliation/sessions');
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// GET /api/v1/cash-reconciliation/sessions/:id
// =============================================================================
describe('GET /api/v1/cash-reconciliation/sessions/:id', () => {
  test('returns 200 with session and payments', async () => {
    mockAuthUser();

    const sessionDetail = {
      session: {
        id: 3,
        organization_id: 1,
        agent_user_id: 1,
        status: 'closed',
        expected_total: '500.00',
        counted_total: '510.00',
        variance: '10.00',
      },
      payments: [
        { id: 1, amount: '200.00', payment_method: 'cash' },
        { id: 2, amount: '300.00', payment_method: 'cash' },
      ],
    };

    cashReconciliationService.getSessionDetail.mockResolvedValueOnce(sessionDetail);
    cashReconciliationService.listPickups.mockResolvedValueOnce([{ id: 9, amount: 4000, status: 'pending' }]);

    const res = await request(app)
      .get('/api/v1/cash-reconciliation/sessions/3')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.session.id).toBe(3);
    expect(res.body.data.payments).toHaveLength(2);
    expect(cashReconciliationService.getSessionDetail).toHaveBeenCalledWith(3, 1);
  });

  test('returns 404 when session not found', async () => {
    mockAuthUser();

    const { NotFoundError } = require('../src/utils/errors');
    cashReconciliationService.getSessionDetail.mockRejectedValueOnce(
      new NotFoundError('cash_reconciliation_sessions'),
    );

    const res = await request(app)
      .get('/api/v1/cash-reconciliation/sessions/999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/v1/cash-reconciliation/sessions/1');
    expect(res.status).toBe(401);
  });
});

// =============================================================================
// POST /api/v1/cash-reconciliation/sessions/:id/close
// =============================================================================
describe('POST /api/v1/cash-reconciliation/sessions/:id/close', () => {
  test('returns 200 with closed session', async () => {
    mockAuthUser();

    const closedSession = {
      id: 1,
      organization_id: 1,
      status: 'closed',
      expected_total: '400.00',
      counted_total: '420.00',
      variance: '20.00',
    };

    cashReconciliationService.closeSession.mockResolvedValueOnce(closedSession);

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/close')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ counted_total: 420 });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('closed');
    expect(cashReconciliationService.closeSession).toHaveBeenCalledWith(1, 1, 420);
  });

  test('returns 422 when session is not open', async () => {
    mockAuthUser();

    const { ValidationError } = require('../src/utils/errors');
    cashReconciliationService.closeSession.mockRejectedValueOnce(
      new ValidationError('Session is not open'),
    );

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/close')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ counted_total: 100 });

    expect(res.status).toBe(422);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/close')
      .send({ counted_total: 100 });

    expect(res.status).toBe(401);
  });
});

// =============================================================================
// POST /api/v1/cash-reconciliation/sessions/:id/approve
// =============================================================================
describe('POST /api/v1/cash-reconciliation/sessions/:id/approve', () => {
  test('returns 200 with approved session', async () => {
    mockAuthUser();

    const approvedSession = {
      id: 1,
      organization_id: 1,
      status: 'approved',
      approved_by: 1,
    };

    cashReconciliationService.approveSession.mockResolvedValueOnce(approvedSession);

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ note: 'cambio mal dado' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
    expect(cashReconciliationService.approveSession).toHaveBeenCalledWith(1, 1, { id: 1, role: 'admin' }, 'cambio mal dado');
  });

  test('returns 422 when session is not closed', async () => {
    mockAuthUser();

    const { ValidationError } = require('../src/utils/errors');
    cashReconciliationService.approveSession.mockRejectedValueOnce(
      new ValidationError('Session must be closed before it can be approved'),
    );

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(422);
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/1/approve')
      .send({});

    expect(res.status).toBe(401);
  });

  test('returns 404 when session not found', async () => {
    mockAuthUser();

    const { NotFoundError } = require('../src/utils/errors');
    cashReconciliationService.approveSession.mockRejectedValueOnce(
      new NotFoundError('cash_reconciliation_sessions'),
    );

    const res = await request(app)
      .post('/api/v1/cash-reconciliation/sessions/999/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

// =============================================================================
// Review, reminders
// =============================================================================
describe('POST /api/v1/cash-reconciliation/sessions/:id/dispute', () => {
  const dispute = (body) => request(app)
    .post('/api/v1/cash-reconciliation/sessions/1/dispute')
    .set('Authorization', `Bearer ${authToken}`)
    .send(body);

  test('disputes with the note', async () => {
    mockAuthUser();
    cashReconciliationService.disputeSession.mockResolvedValueOnce({ id: 1, status: 'disputed' });
    const res = await dispute({ note: 'faltan 20 sin explicar' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('disputed');
    expect(cashReconciliationService.disputeSession).toHaveBeenCalledWith(1, 1, { id: 1, role: 'admin' }, 'faltan 20 sin explicar');
  });

  test('a dispute without a note is refused before the service', async () => {
    mockAuthUser();
    expect((await dispute({})).status).toBe(422);
    mockAuthUser();
    expect((await dispute({ note: 'a' })).status).toBe(422);
    expect(cashReconciliationService.disputeSession).not.toHaveBeenCalled();
  });

  test('returns 401 without auth token', async () => {
    const res = await request(app).post('/api/v1/cash-reconciliation/sessions/1/dispute').send({ note: 'faltan 20' });
    expect(res.status).toBe(401);
  });
});

describe('the reminder routes', () => {
  test('my-cashier answers the caller\'s own open cashier, or null', async () => {
    mockAuthUser();
    cashReconciliationService.myOpenSession.mockResolvedValueOnce({ id: 7, hours_open: 3, overdue: false });
    const res = await request(app).get('/api/v1/cash-reconciliation/my-cashier').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 7, overdue: false });
    expect(cashReconciliationService.myOpenSession).toHaveBeenCalledWith(1, 1);

    mockAuthUser();
    cashReconciliationService.myOpenSession.mockResolvedValueOnce(null);
    const none = await request(app).get('/api/v1/cash-reconciliation/my-cashier').set('Authorization', `Bearer ${authToken}`);
    expect(none.body).toEqual({ data: null });
  });

  test('attention answers what a supervisor should look at', async () => {
    mockAuthUser();
    cashReconciliationService.attention.mockResolvedValueOnce({ max_open_hours: 16, overdue_open: [], awaiting_review: 2 });
    const res = await request(app).get('/api/v1/cash-reconciliation/attention').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.awaiting_review).toBe(2);
    expect(cashReconciliationService.attention).toHaveBeenCalledWith(1);
  });

  test('both need a sign-in', async () => {
    expect((await request(app).get('/api/v1/cash-reconciliation/my-cashier')).status).toBe(401);
    expect((await request(app).get('/api/v1/cash-reconciliation/attention')).status).toBe(401);
  });

  test('my-cashier is not read as a session id', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'cashReconciliation.js'), 'utf8');
    expect(src.indexOf("router.get('/my-cashier'")).toBeGreaterThan(-1);
    expect(src.indexOf("router.get('/attention'")).toBeGreaterThan(-1);
  });

  test('the permissions: anyone who opens or views cashiers sees their own; only approvers see the supervisor list or review', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'cashReconciliation.js'), 'utf8');
    expect(src).toMatch(/router\.get\('\/my-cashier', requirePermission\('cash_reconciliation\.create', 'cash_reconciliation\.view'\)/);
    expect(src).toMatch(/router\.get\('\/attention', requirePermission\('cash_reconciliation\.approve'\)/);
    expect(src).toMatch(/router\.post\('\/sessions\/:id\/dispute', requirePermission\('cash_reconciliation\.approve'\)/);
  });
});

// =============================================================================
// Opening count, rules, pickups
// =============================================================================
describe('opening a cashier', () => {
  const open = (body) => request(app).post('/api/v1/cash-reconciliation/sessions').set('Authorization', `Bearer ${authToken}`).send(body);

  test('the cash counted in the drawer is required', async () => {
    mockAuthUser();
    expect((await open({})).status).toBe(422);
    mockAuthUser();
    expect((await open({ opening_total: -1 })).status).toBe(422);
    expect(cashReconciliationService.openSession).not.toHaveBeenCalled();
  });

  test('GET /opening answers what the caller\'s drawer should hold', async () => {
    mockAuthUser();
    cashReconciliationService.openingExpectation.mockResolvedValueOnce(480);
    const res = await request(app).get('/api/v1/cash-reconciliation/opening').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ expected: 480 });
    expect(cashReconciliationService.openingExpectation).toHaveBeenCalledWith(1, 1);
  });
});

describe('the session detail lists its pickups', () => {
  test('pickups come with the session and its payments', async () => {
    mockAuthUser();
    cashReconciliationService.getSessionDetail.mockResolvedValueOnce({ session: { id: 3 }, payments: [] });
    cashReconciliationService.listPickups.mockResolvedValueOnce([{ id: 9, amount: 4000, status: 'pending' }]);
    const res = await request(app).get('/api/v1/cash-reconciliation/sessions/3').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.pickups).toEqual([{ id: 9, amount: 4000, status: 'pending' }]);
    expect(cashReconciliationService.listPickups).toHaveBeenCalledWith(1, 3);
  });
});

describe('cashier rules', () => {
  const rules = { tolerance: 0, maxOpenHours: 16, pickupThreshold: 5000, pickupStrict: true };

  test('anyone who uses the cashier reads them', async () => {
    mockAuthUser();
    cashReconciliationService.rules.mockResolvedValueOnce(rules);
    const res = await request(app).get('/api/v1/cash-reconciliation/rules').set('Authorization', `Bearer ${authToken}`);
    expect(res.body.data).toEqual({ match_tolerance: 0, max_open_hours: 16, pickup_threshold: 5000, pickup_strict: true });
  });

  test('a supervisor sets the threshold and the strict switch', async () => {
    mockAuthUser();
    cashReconciliationService.setPickupRules.mockResolvedValueOnce(rules);
    const res = await request(app).put('/api/v1/cash-reconciliation/rules').set('Authorization', `Bearer ${authToken}`)
      .send({ pickup_threshold: 5000, pickup_strict: true });
    expect(res.status).toBe(200);
    expect(res.body.data.pickup_strict).toBe(true);
    expect(cashReconciliationService.setPickupRules).toHaveBeenCalledWith(1, { pickup_threshold: 5000, pickup_strict: true });
  });

  test('a negative threshold or a strict that is not yes or no is refused', async () => {
    mockAuthUser();
    expect((await request(app).put('/api/v1/cash-reconciliation/rules').set('Authorization', `Bearer ${authToken}`).send({ pickup_threshold: -5 })).status).toBe(422);
    mockAuthUser();
    expect((await request(app).put('/api/v1/cash-reconciliation/rules').set('Authorization', `Bearer ${authToken}`).send({ pickup_strict: 'maybe' })).status).toBe(422);
    expect(cashReconciliationService.setPickupRules).not.toHaveBeenCalled();
  });
});

describe('cash pickups', () => {
  test('a supervisor records one with the amount and a note', async () => {
    mockAuthUser();
    cashReconciliationService.createPickup.mockResolvedValueOnce({ id: 9, status: 'pending', amount: 4000 });
    const res = await request(app).post('/api/v1/cash-reconciliation/sessions/3/pickups').set('Authorization', `Bearer ${authToken}`)
      .send({ amount: 4000, note: 'a la caja fuerte' });
    expect(res.status).toBe(201);
    expect(cashReconciliationService.createPickup).toHaveBeenCalledWith(1, 3, { id: 1, role: 'admin' }, 4000, 'a la caja fuerte');
  });

  test('an amount is required and must be more than zero', async () => {
    for (const body of [{}, { amount: 0 }, { amount: -10 }]) {
      mockAuthUser();
      const res = await request(app).post('/api/v1/cash-reconciliation/sessions/3/pickups').set('Authorization', `Bearer ${authToken}`).send(body);
      expect(res.status).toBe(422);
    }
    expect(cashReconciliationService.createPickup).not.toHaveBeenCalled();
  });

  test('the owner confirms, and either side cancels', async () => {
    mockAuthUser();
    cashReconciliationService.confirmPickup.mockResolvedValueOnce({ id: 9, status: 'confirmed' });
    const ok = await request(app).post('/api/v1/cash-reconciliation/pickups/9/confirm').set('Authorization', `Bearer ${authToken}`);
    expect(ok.body.data.status).toBe('confirmed');
    expect(cashReconciliationService.confirmPickup).toHaveBeenCalledWith(1, 9, 1);
    mockAuthUser();
    cashReconciliationService.cancelPickup.mockResolvedValueOnce({ id: 9, status: 'cancelled' });
    const no = await request(app).post('/api/v1/cash-reconciliation/pickups/9/cancel').set('Authorization', `Bearer ${authToken}`);
    expect(no.body.data.status).toBe('cancelled');
    expect(cashReconciliationService.cancelPickup).toHaveBeenCalledWith(1, 9, 1);
  });

  test('every pickup and rules route needs a sign-in', async () => {
    for (const [method, path] of [['post', '/sessions/3/pickups'], ['post', '/pickups/9/confirm'], ['post', '/pickups/9/cancel'], ['get', '/rules'], ['put', '/rules'], ['get', '/opening']]) {
      expect([path, (await request(app)[method](`/api/v1/cash-reconciliation${path}`).send({ amount: 1 })).status]).toEqual([path, 401]);
    }
  });

  test('the permissions: supervisors record pickups and set the rules; the owner confirms', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'cashReconciliation.js'), 'utf8');
    expect(src).toMatch(/router\.post\('\/sessions\/:id\/pickups', requirePermission\('cash_reconciliation\.approve'\)/);
    expect(src).toMatch(/router\.put\('\/rules', requirePermission\('cash_reconciliation\.approve'\)/);
    expect(src).toMatch(/router\.post\('\/pickups\/:id\/confirm', requirePermission\('cash_reconciliation\.create'\)/);
    expect(src).toMatch(/router\.get\('\/opening', requirePermission\('cash_reconciliation\.create'\)/);
  });
});
