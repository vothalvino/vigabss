// =============================================================================
// Reseller app, phase 3 (migration 005): cash bags and carriers
// =============================================================================
// The ISP registers numbered money bags and hands them to a carrier, which
// drops them off empty at resellers; a reseller seals the cash it holds in one
// (a bag_sealed ledger line takes the cash off its balance and frees the limit
// at once, migration 006), the carrier picks it up by its serial and the ISP
// counts and receives it, posting only a difference to the reseller ledger.
// A lost bag posts nothing: the ISP absorbs it. Carriers are fenced to the carrier app. The database is an
// in-memory fake with transaction snapshots (tests/helpers/cashBagFakeDb.js).
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((_orgId, fn) => fn()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const auditLog = require('../src/services/auditLog');
const cashBags = require('../src/services/cashBagService');
const { handleCashBagSql } = require('./helpers/cashBagFakeDb');
const app = require('../src/app');

const ORG = 1;
const OTHER_ORG = 2;
const ADMIN = 7;
const CARRIER = 40;
const CARRIER_2 = 41;
const RESELLER_USER = 60;
const SUB_RESELLER_USER = 61;
const CARRIER_GROUP = 50;

const ROLES = {
  1: { id: 1, name: 'admin', kind: 'admin', is_system: 1 },
  8: { id: 8, name: 'reseller_admin', kind: 'billing', is_system: 1 },
  [CARRIER_GROUP]: { id: CARRIER_GROUP, name: 'carrier', kind: 'readonly', is_system: 1 },
};
const USERS = {
  [ADMIN]: { id: ADMIN, first_name: 'Ana', last_name: 'Admin', email: 'admin@example.com', group_id: 1, organization_id: ORG, role: 'support' },
  [CARRIER]: { id: CARRIER, first_name: 'Carlos', last_name: 'Ruta', email: 'carlos@example.com', group_id: CARRIER_GROUP, organization_id: ORG, role: 'readonly', phone: '722 000 0040' },
  [CARRIER_2]: { id: CARRIER_2, first_name: 'Rosa', last_name: 'Ruta', email: 'rosa@example.com', group_id: CARRIER_GROUP, organization_id: ORG, role: 'readonly', phone: null },
  [RESELLER_USER]: { id: RESELLER_USER, first_name: 'Lupita', last_name: 'Tienda', email: 'lupita@example.com', group_id: 8, organization_id: ORG, role: 'billing' },
  [SUB_RESELLER_USER]: { id: SUB_RESELLER_USER, first_name: 'Norte', last_name: 'Tienda', email: 'norte@example.com', group_id: 8, organization_id: ORG, role: 'billing' },
};
const BINDINGS = { [RESELLER_USER]: 1, [SUB_RESELLER_USER]: 3 };

const ADMIN_PERMISSIONS = [
  'cash_bags.view', 'cash_bags.manage', 'cash_bags.receive', 'carriers.manage',
  'resellers.view', 'resellers.update', 'users.update', 'reseller_ledger.view', 'reseller_ledger.manage', 'clients.view',
];
const CARRIER_PERMISSIONS = ['carrier_app.use', 'carrier_app.pickup', 'clients.view', 'cash_bags.view', 'resellers.view'];
const RESELLER_PERMISSIONS = ['reseller_app.use', 'reseller_app.collect', 'reseller_app.bags', 'cash_bags.view', 'cash_bags.manage'];

// ---------------------------------------------------------------------------
// In-memory organization
// ---------------------------------------------------------------------------
let state;
let snapshot;
let permissions;

function bag(id, serial, status, extra = {}) {
  return {
    id, organization_id: ORG, serial, status, reseller_id: null, carrier_user_id: null,
    declared_amount: null, counted_amount: null, currency: 'MXN', notes: null, created_by: ADMIN,
    sealed_at: null, sealed_by: null, picked_up_at: null, picked_up_by: null, received_at: null, received_by: null,
    created_at: new Date('2026-11-01T10:00:00Z'), updated_at: new Date('2026-11-01T10:00:00Z'), deleted_at: null,
    ...extra,
  };
}

function freshState() {
  return {
    resellers: {
      1: { id: 1, organization_id: ORG, parent_id: null, level: 1, name: 'Tienda Lupita', status: 'active', commission_rate: '10.00', credit_limit: '1000.00', phone: '722 555 0001', address: 'Av. Juárez 10', city: 'Toluca', latitude: '19.2826000', longitude: '-99.6557000', deleted_at: null },
      2: { id: 2, organization_id: ORG, parent_id: null, level: 1, name: 'Papelería Sol', status: 'active', commission_rate: '5.00', credit_limit: null, phone: null, address: null, city: null, latitude: null, longitude: null, deleted_at: null },
      3: { id: 3, organization_id: ORG, parent_id: 1, level: 2, name: 'Lupita Norte', status: 'active', commission_rate: '0.00', credit_limit: null, deleted_at: null },
      9: { id: 9, organization_id: OTHER_ORG, parent_id: null, level: 1, name: 'Otra Tienda', status: 'active', commission_rate: '0.00', credit_limit: null, deleted_at: null },
    },
    bags: [
      bag(101, 'BAG-101', 'in_stock'),
      bag(102, 'BAG-102', 'in_stock'),
      bag(103, 'BAG-103', 'with_carrier', { carrier_user_id: CARRIER }),
      bag(104, 'BAG-104', 'with_carrier', { carrier_user_id: CARRIER_2 }),
      bag(105, 'BAG-105', 'at_reseller', { reseller_id: 1, carrier_user_id: CARRIER }),
      bag(106, 'BAG-106', 'ready_for_pickup', { reseller_id: 1, carrier_user_id: CARRIER, declared_amount: '300.00', sealed_at: new Date(), sealed_by: RESELLER_USER }),
      bag(107, 'BAG-107', 'at_reseller', { reseller_id: 2, carrier_user_id: CARRIER }),
      bag(108, 'BAG-108', 'ready_for_pickup', { reseller_id: 2, carrier_user_id: CARRIER, declared_amount: '50.00' }),
      bag(109, 'BAG-109', 'in_transit', { reseller_id: 1, carrier_user_id: CARRIER, declared_amount: '200.00', picked_up_at: new Date(), picked_up_by: CARRIER }),
      // Another organization: the same serial as bag 106.
      { ...bag(901, 'BAG-106', 'ready_for_pickup', { reseller_id: 9, declared_amount: '10.00' }), organization_id: OTHER_ORG },
    ],
    events: [],
    assignments: [
      { organization_id: ORG, carrier_user_id: CARRIER, reseller_id: 1 },
      { organization_id: ORG, carrier_user_id: CARRIER_2, reseller_id: 1 },
    ],
    // R1 collected 800 and sealed 500 of it in bags 106 and 109, which took
    // it off its balance: it owes (and holds) 300. R2 sealed all its 50.
    ledger: [
      { id: 1, organization_id: ORG, reseller_id: 1, entry_type: 'collection', amount: '800.00', currency: 'MXN', payment_id: 500, cash_session_id: 40, cash_bag_id: null, note: null, created_by: RESELLER_USER, created_at: new Date('2026-11-02T10:00:00Z') },
      { id: 2, organization_id: ORG, reseller_id: 2, entry_type: 'collection', amount: '50.00', currency: 'MXN', payment_id: 501, cash_session_id: 41, cash_bag_id: null, note: null, created_by: RESELLER_USER, created_at: new Date('2026-11-02T10:00:00Z') },
      { id: 3, organization_id: ORG, reseller_id: 1, entry_type: 'bag_sealed', amount: '-300.00', currency: 'MXN', payment_id: null, cash_session_id: null, cash_bag_id: 106, note: 'Bolsa BAG-106 sellada', created_by: RESELLER_USER, created_at: new Date('2026-11-02T11:00:00Z') },
      { id: 4, organization_id: ORG, reseller_id: 2, entry_type: 'bag_sealed', amount: '-50.00', currency: 'MXN', payment_id: null, cash_session_id: null, cash_bag_id: 108, note: 'Bolsa BAG-108 sellada', created_by: RESELLER_USER, created_at: new Date('2026-11-02T11:00:00Z') },
      { id: 5, organization_id: ORG, reseller_id: 1, entry_type: 'bag_sealed', amount: '-200.00', currency: 'MXN', payment_id: null, cash_session_id: null, cash_bag_id: 109, note: 'Bolsa BAG-109 sellada', created_by: RESELLER_USER, created_at: new Date('2026-11-02T11:00:00Z') },
    ],
    seq: { bag: 200, event: 0, ledger: 10 },
  };
}

const clone = (v) => globalThis.structuredClone(v);
const cents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const ledgerSum = (rid) => state.ledger.filter((e) => e.reseller_id === rid).reduce((t, e) => t + cents(e.amount), 0);
const LEDGER_AT_START = 5;
const bagBySerial = (serial, org = ORG) => state.bags.find((b) => b.serial === serial && b.organization_id === org);

function handle(sql, params = []) {
  const s = String(sql);
  const bagAnswer = handleCashBagSql(state, s, params);
  if (bagAnswer !== undefined) return bagAnswer;
  // --- identities, groups, bindings
  if (/FROM reseller_user_bindings b/.test(s)) {
    const rid = BINDINGS[Number(params[1])];
    return [rid ? [{ reseller_id: rid, live_reseller_id: rid, reseller_name: state.resellers[rid].name }] : []];
  }
  if (/FROM users u\s+JOIN roles g ON g\.id = u\.group_id AND g\.name = 'carrier'/.test(s)) {
    const carriers = Object.values(USERS).filter((u) => u.group_id === CARRIER_GROUP);
    if (/WHERE u\.id = \?/.test(s)) {
      const u = carriers.find((x) => x.id === Number(params[0]) && x.organization_id === Number(params[1]));
      return [u ? [{ ...u, status: 'active' }] : []];
    }
    return [carriers.filter((u) => u.organization_id === Number(params[0])).map((u) => ({ ...u, status: 'active' }))];
  }
  if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) {
    const u = USERS[Number(params[0])];
    return [u ? [{ group_name: ROLES[u.group_id].name }] : []];
  }
  if (/SELECT name, is_system FROM roles WHERE id = \?/.test(s)) {
    const r = ROLES[Number(params[0])];
    return [r ? [{ name: r.name, is_system: r.is_system }] : []];
  }
  if (/SELECT id FROM roles WHERE name = 'carrier'/.test(s)) return [[{ id: CARRIER_GROUP }]];
  if (/SELECT id, name, kind, is_system FROM roles WHERE id = \?/.test(s)) {
    const r = ROLES[Number(params[0])];
    return [r ? [{ ...r }] : []];
  }
  if (/SELECT id, first_name, last_name FROM users WHERE id IN/.test(s)) {
    return [params.map(Number).filter((id) => USERS[id]).map((id) => ({ id, first_name: USERS[id].first_name, last_name: USERS[id].last_name }))];
  }
  if (/SELECT status, token_version FROM users/.test(s)) return [[{ status: 'active', token_version: 0 }]];
  if (/SELECT currency FROM organizations/.test(s)) return [[{ currency: 'MXN' }]];
  if (/FROM organization_settings/.test(s)) return [[]];
  // --- resellers
  if (/FROM resellers\s+WHERE organization_id = \? AND parent_id IN/.test(s)) {
    const parents = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => r.organization_id === Number(params[0]) && parents.includes(r.parent_id)).map((r) => ({ id: r.id }))];
  }
  if (/FROM resellers\s+WHERE id = \? AND organization_id = \?/.test(s) || /^SELECT \* FROM resellers WHERE id = \? AND organization_id = \?/.test(s)) {
    const r = state.resellers[Number(params[0])];
    return [r && r.organization_id === Number(params[1]) ? [{ ...r }] : []];
  }
  if (/FROM resellers r\s+LEFT JOIN resellers p/.test(s)) return [Object.values(state.resellers).filter((r) => r.organization_id === ORG).map((r) => ({ ...r }))];
  if (/COUNT\(\*\) AS total FROM resellers r/.test(s)) return [[{ total: 3 }]];
  if (/^\s*UPDATE resellers SET/.test(s)) {
    // PUT /resellers/:id: COALESCE(?, col) keeps the column on null;
    // IF(?, ?, col) sets the value only when the flag is 1.
    const rest = [...params];
    const changes = {};
    for (const [, col, kind] of s.matchAll(/(\w+) = (COALESCE\(\?, \w+\)|IF\(\?, \?, \w+\))/g)) {
      if (kind.startsWith('COALESCE')) { const v = rest.shift(); if (v !== null) changes[col] = v; } else {
        const flag = rest.shift(); const v = rest.shift(); if (flag) changes[col] = v;
      }
    }
    const [id, orgId] = rest.map(Number);
    const r = state.resellers[id];
    if (r && r.organization_id === orgId && !r.deleted_at) Object.assign(r, changes);
    return [{ affectedRows: r ? 1 : 0 }];
  }
  // --- reseller ledger
  if (/GROUP BY reseller_id/.test(s) && /FROM reseller_ledger_entries/.test(s)) {
    return [params.slice(1).map(Number).map((id) => ({ reseller_id: id, balance: fromCents(ledgerSum(id)) }))];
  }
  if (/SUM\(amount\), 0\) AS balance\s+FROM reseller_ledger_entries/.test(s)) return [[{ balance: fromCents(ledgerSum(Number(params[1]))) }]];
  if (/INSERT INTO reseller_ledger_entries/.test(s)) {
    const [orgId, resellerId, entryType, amount, currency, paymentId, cashSessionId, note, createdBy, cashBagId] = params;
    const id = ++state.seq.ledger;
    state.ledger.push({ id, organization_id: orgId, reseller_id: resellerId, entry_type: entryType, amount: Number(amount).toFixed(2), currency, payment_id: paymentId, cash_session_id: cashSessionId, cash_bag_id: cashBagId ?? null, note, created_by: createdBy, created_at: new Date() });
    return [{ insertId: id }];
  }
  if (/FROM reseller_ledger_entries\s+WHERE organization_id = \? AND reseller_id = \?\s+ORDER BY/.test(s)) {
    return [state.ledger.filter((e) => e.reseller_id === Number(params[1])).slice().reverse()];
  }
  if (/COUNT\(\*\) AS total FROM reseller_ledger_entries/.test(s)) return [[{ total: state.ledger.filter((e) => e.reseller_id === Number(params[1])).length }]];
  if (/FROM reseller_ledger_entries WHERE id = \?/.test(s)) return [state.ledger.filter((e) => e.id === Number(params[0]))];
  // --- /me counts
  if (/AS active_clients/.test(s)) return [[{ active_clients: 0, suspended_clients: 0 }]];
  if (/AS open_leads/.test(s)) return [[{ open_leads: 0 }]];
  if (/AS overdue_clients/.test(s)) return [[{ overdue_clients: 0 }]];
  if (/SUM\(p\.amount\), 0\) AS total\s+FROM payments p/.test(s)) return [[{ total: '0.00' }]];
  return [[]];
}

const mockQuery = jest.fn(async (sql, params) => handle(sql, params));

function tokenAs(userId, perms) {
  permissions = perms;
  User.findById.mockImplementation(async (id) => (USERS[Number(id)] ? { ...USERS[Number(id)], status: 'active', token_version: 0 } : null));
  User.getPermissions.mockImplementation(async () => permissions);
  const u = USERS[userId];
  return jwt.sign({ sub: userId, email: u.email, role: u.role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}
const asAdmin = (perms = ADMIN_PERMISSIONS) => tokenAs(ADMIN, perms);
const asCarrier = (perms = CARRIER_PERMISSIONS, id = CARRIER) => tokenAs(id, perms);
const asReseller = (perms = RESELLER_PERMISSIONS, id = RESELLER_USER) => tokenAs(id, perms);

const auth = (r, token) => r.set('Authorization', `Bearer ${token}`);
const get = (path, token) => auth(request(app).get(`/api/v1${path}`), token);
const post = (path, token, body = {}) => auth(request(app).post(`/api/v1${path}`), token).send(body);
const put = (path, token, body = {}) => auth(request(app).put(`/api/v1${path}`), token).send(body);

let conn;
beforeEach(() => {
  jest.resetAllMocks();
  state = freshState();
  snapshot = null;
  db.withTenantContext.mockImplementation((_orgId, fn) => fn());
  mockQuery.mockImplementation(async (sql, params) => handle(sql, params));
  db.query.mockImplementation(mockQuery);
  conn = {
    beginTransaction: jest.fn(async () => { snapshot = clone(state); }),
    query: jest.fn(mockQuery),
    execute: jest.fn(mockQuery),
    commit: jest.fn(async () => { snapshot = null; }),
    rollback: jest.fn(async () => { if (snapshot) { state = snapshot; snapshot = null; } }),
    release: jest.fn(),
  };
  db.getConnection.mockResolvedValue(conn);
});

/** The FOR UPDATE statements a transaction ran, in order: 'resellers' or 'cash_bags'. */
function lockOrder() {
  return conn.execute.mock.calls.map(([sql]) => String(sql))
    .filter((sql) => /FOR UPDATE/.test(sql))
    .map((sql) => (/FROM resellers/.test(sql) ? 'resellers' : /FROM cash_bags/.test(sql) ? 'cash_bags' : 'other'));
}

const MONEY_KEYS = /amount|balance|cash_on_hand|in_bags|credit_limit|available_to_collect|variance/;

// ---------------------------------------------------------------------------
describe('the state machine', () => {
  const EXPECTED = {
    handover: { in_stock: 'with_carrier' },
    dropoff: { with_carrier: 'at_reseller' },
    seal: { at_reseller: 'ready_for_pickup', with_carrier: 'ready_for_pickup' },
    pickup: { ready_for_pickup: 'in_transit' },
    receive: { in_transit: 'received', ready_for_pickup: 'received' },
    void: { in_stock: 'void', with_carrier: 'void', at_reseller: 'void' },
    lose: { ready_for_pickup: 'lost', in_transit: 'lost' },
    return: { with_carrier: 'in_stock', at_reseller: 'with_carrier' },
  };

  test.each(Object.keys(EXPECTED))('%s is allowed exactly from its statuses', (action) => {
    for (const from of cashBags.BAG_STATUSES) {
      expect([from, cashBags.nextStatus(action, from)]).toEqual([from, EXPECTED[action][from] ?? null]);
    }
  });

  test('received, void and lost are terminal', () => {
    for (const from of cashBags.TERMINAL_STATUSES) {
      for (const to of cashBags.BAG_STATUSES) expect(cashBags.transitionAllowed(from, to)).toBe(false);
    }
  });

  test('a bag with money in it can never be voided, and one without can never be lost', () => {
    for (const from of ['ready_for_pickup', 'in_transit']) expect(cashBags.transitionAllowed(from, 'void')).toBe(false);
    for (const from of ['in_stock', 'with_carrier', 'at_reseller']) expect(cashBags.transitionAllowed(from, 'lost')).toBe(false);
    expect(cashBags.transitionAllowed('in_stock', 'ready_for_pickup')).toBe(false);
    expect(cashBags.transitionAllowed('at_reseller', 'received')).toBe(false);
  });

  test('a refused move is a 409 naming the bag and its status', () => {
    expect(() => cashBags.assertTransition({ serial: 'B1', status: 'in_stock' }, 'seal'))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'BAG_INVALID_TRANSITION' }));
  });

  test('serials are trimmed and uppercased, and odd ones refused', () => {
    expect(cashBags.normalizeSerial('  bag-001 ')).toBe('BAG-001');
    expect(cashBags.normalizeSerial('a b')).toBeNull();
    expect(cashBags.normalizeSerial('')).toBeNull();
    expect(cashBags.normalizeSerial('x'.repeat(65))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('registration (POST /cash-bags)', () => {
  test('one serial is stored normalized, in stock, with a registration event', async () => {
    const res = await post('/cash-bags', asAdmin(), { serial: '  bolsa-77 ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ created: [{ id: 201, serial: 'BOLSA-77' }], skipped: [] });
    expect(bagBySerial('BOLSA-77')).toMatchObject({ status: 'in_stock', currency: 'MXN', created_by: ADMIN });
    expect(state.events).toEqual([expect.objectContaining({ bag_id: 201, from_status: null, to_status: 'in_stock', actor_user_id: ADMIN })]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'cash_bag_register', tableName: 'cash_bags' }));
  });

  test('a range pads its numbers and skips serials that exist', async () => {
    state.bags.push(bag(150, 'R02', 'in_stock'));
    const res = await post('/cash-bags', asAdmin(), { prefix: 'r', from: 1, to: 3, pad: 2 });
    expect(res.status).toBe(201);
    expect(res.body.data.created.map((b) => b.serial)).toEqual(['R01', 'R03']);
    expect(res.body.data.skipped).toEqual(['R02']);
    // pad defaults to the digits of `to`
    const padded = await post('/cash-bags', asAdmin(), { prefix: 'Z', from: 8, to: 10 });
    expect(padded.body.data.created.map((b) => b.serial)).toEqual(['Z08', 'Z09', 'Z10']);
  });

  test('every serial existing is a 409, and a range over 500 a 422', async () => {
    const dup = await post('/cash-bags', asAdmin(), { serial: 'bag-101' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'BAG_SERIALS_EXIST', details: { skipped: ['BAG-101'] } });
    const big = await post('/cash-bags', asAdmin(), { prefix: 'X', from: 1, to: 501 });
    expect(big.status).toBe(422);
    expect((await post('/cash-bags', asAdmin(), {})).status).toBe(422);
    expect(state.bags).toHaveLength(10);
  });

  test('needs cash_bags.manage', async () => {
    expect((await post('/cash-bags', asAdmin(['cash_bags.view']), { serial: 'NEW-1' })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('hand over to a carrier (POST /cash-bags/handover)', () => {
  test('bags in stock go to the carrier for one of its points, which owns them at once', async () => {
    const res = await post('/cash-bags/handover', asAdmin(), { carrier_user_id: CARRIER, reseller_id: 1, serials: ['bag-101', 'BAG-102'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      carrier_user_id: CARRIER, carrier_name: 'Carlos Ruta', reseller_id: 1, reseller_name: 'Tienda Lupita',
      bags: [{ id: 101, serial: 'BAG-101', status: 'with_carrier' }, { id: 102, serial: 'BAG-102', status: 'with_carrier' }],
    });
    expect(bagBySerial('BAG-101')).toMatchObject({ status: 'with_carrier', carrier_user_id: CARRIER, reseller_id: 1 });
    expect(state.events.map((e) => [e.bag_id, e.from_status, e.to_status, e.reseller_id])).toEqual([[101, 'in_stock', 'with_carrier', 1], [102, 'in_stock', 'with_carrier', 1]]);
    // The point first, then the bags (the events' foreign key checks the point).
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
    // The point sees them on its way and counts them as bags it may fill.
    const mine = await get('/reseller-app/bags', asReseller());
    expect(mine.body.data.filter((b) => b.status === 'with_carrier').map((b) => b.serial)).toEqual(['BAG-101', 'BAG-102']);
    expect(mine.body.summary).toMatchObject({ empty_bags: 3, bags_on_the_way: 2 });
    // The carrier sees where each goes.
    const carried = await get('/carrier-app/bags', asCarrier());
    expect(carried.body.data.find((b) => b.serial === 'BAG-101')).toEqual({ id: 101, serial: 'BAG-101', status: 'with_carrier', reseller_id: 1, reseller_name: 'Tienda Lupita', picked_up_at: null });
  });

  test('the point must be one of the carrier\'s points, and is required', async () => {
    const other = await post('/cash-bags/handover', asAdmin(), { carrier_user_id: CARRIER, reseller_id: 2, serials: ['BAG-101'] });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('POINT_NOT_ASSIGNED_TO_CARRIER');
    expect((await post('/cash-bags/handover', asAdmin(), { carrier_user_id: CARRIER, serials: ['BAG-101'] })).status).toBe(422);
    expect(bagBySerial('BAG-101')).toMatchObject({ status: 'in_stock', reseller_id: null });
    expect(state.events).toHaveLength(0);
  });

  test('all or nothing: one bag not in stock moves none', async () => {
    const res = await post('/cash-bags/handover', asAdmin(), { carrier_user_id: CARRIER, reseller_id: 1, bag_ids: [101, 105, 999] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'BAGS_NOT_IN_STOCK', details: { failed: ['BAG-105', '999'] } });
    expect(bagBySerial('BAG-101').status).toBe('in_stock');
    expect(state.events).toHaveLength(0);
  });

  test('the user must be a carrier of the organization', async () => {
    const res = await post('/cash-bags/handover', asAdmin(), { carrier_user_id: RESELLER_USER, reseller_id: 1, serials: ['BAG-101'] });
    expect(res.status).toBe(422);
    expect(bagBySerial('BAG-101').status).toBe('in_stock');
  });
});

// ---------------------------------------------------------------------------
describe('the carrier fence', () => {
  test('a carrier is refused every staff route whatever its permissions, GraphQL included', async () => {
    const token = asCarrier();
    for (const path of ['/clients', '/cash-bags', '/resellers', '/resellers/1', '/reseller-app/me', '/carriers']) {
      const res = await get(path, token);
      expect([path, res.status, res.body.error.message]).toEqual([path, 403, 'Carrier accounts can only use the carrier app']);
    }
    const gql = await post('/graphql', token, { query: '{ __typename }' });
    expect(gql.status).toBe(403);
  });

  test('a carrier with no assignments is still fenced, and reaches /auth/me with carrier: true', async () => {
    state.assignments = [];
    const token = asCarrier();
    expect((await get('/clients', token)).status).toBe(403);
    User.getOrganizations.mockResolvedValue([]);
    const me = await get('/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body.data.carrier).toBe(true);
    expect(me.body.data.reseller_binding).toBeNull();
    const resellers = await get('/carrier-app/resellers', token);
    expect(resellers.status).toBe(200);
    expect(resellers.body.data).toEqual([]);
  });

  test('org-level staff are not carriers and cannot use the carrier app', async () => {
    const token = asAdmin([...ADMIN_PERMISSIONS, 'carrier_app.use']);
    User.getOrganizations.mockResolvedValue([]);
    expect((await get('/auth/me', token)).body.data.carrier).toBe(false);
    const res = await get('/carrier-app/me', token);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only carrier accounts can use the carrier app');
  });

  test('a reseller-bound user never reaches the carrier app', async () => {
    const res = await get('/carrier-app/me', asReseller([...RESELLER_PERMISSIONS, 'carrier_app.use']));
    expect(res.status).toBe(403);
  });

  test('the allowed paths', () => {
    const { isCarrierAllowedPath, isResellerAllowedPath } = require('../src/middleware/resellerFence');
    expect(isCarrierAllowedPath('/carrier-app/pickup')).toBe(true);
    expect(isCarrierAllowedPath('/security-admin/webauthn')).toBe(true);
    expect(isCarrierAllowedPath('/notifications')).toBe(true);
    expect(isCarrierAllowedPath('/reseller-app/me')).toBe(false);
    expect(isCarrierAllowedPath('/carrier-appx')).toBe(false);
    expect(isResellerAllowedPath('/carrier-app/me')).toBe(false);
  });

  test('real-time feeds refuse a carrier', async () => {
    const realtimeAccess = require('../src/services/realtimeAccess');
    expect(await realtimeAccess.carrierAccount({ userId: CARRIER, groupId: CARRIER_GROUP })).toBe(true);
    expect(await realtimeAccess.carrierAccount({ userId: ADMIN, groupId: 1 })).toBe(false);
    expect(await realtimeAccess.carrierAccount({ userId: ADMIN, groupId: null })).toBe(false);
    expect(await realtimeAccess.carrierAccount({ userId: CARRIER })).toBe(true);
    expect(await realtimeAccess.stillAuthorized({ userId: CARRIER, tokenVersion: 0, orgId: ORG })).toBe(false);
    expect(await realtimeAccess.stillAuthorized({ userId: ADMIN, tokenVersion: 0, orgId: ORG })).toBe(true);
  });

  test('the WebSocket hub refuses a carrier at sign-in', () => {
    const source = require('fs').readFileSync(require.resolve('../src/services/wsHub'), 'utf8');
    expect(source).toMatch(/realtimeAccess\.carrierAccount\(\{ \.\.\.resellerPrincipal, groupId: user\.group_id \?\? null \}\)/);
  });

  test('a carrier cannot be bound to a reseller', async () => {
    User.count.mockResolvedValue(1);
    const res = await put(`/resellers/1/users/${CARRIER}`, asAdmin());
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('A carrier account cannot be bound to a reseller');
    expect(mockQuery.mock.calls.filter(([q]) => /INSERT INTO reseller_user_bindings/.test(q))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('the carrier app', () => {
  test('lists only the assigned resellers, with bag counts and no money', async () => {
    const res = await get('/carrier-app/resellers', asCarrier());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{
      id: 1, name: 'Tienda Lupita', address: 'Av. Juárez 10', city: 'Toluca', phone: '722 555 0001',
      latitude: 19.2826, longitude: -99.6557, counts: { ready_for_pickup: 1, empty_bags: 1, to_deliver: 0 },
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(MONEY_KEYS);
  });

  test('/me counts its stock, what it carries and its resellers', async () => {
    const res = await get('/carrier-app/me', asCarrier());
    expect(res.body.data).toEqual({
      carrier: { user_id: CARRIER, first_name: 'Carlos', last_name: 'Ruta', name: 'Carlos Ruta' },
      counts: { stock: 1, in_transit: 1, assigned_resellers: 1 },
    });
  });

  test('/bags lists its own bags without amounts', async () => {
    const res = await get('/carrier-app/bags', asCarrier());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: 103, serial: 'BAG-103', status: 'with_carrier', reseller_id: null, reseller_name: null, picked_up_at: null },
      { id: 109, serial: 'BAG-109', status: 'in_transit', reseller_id: 1, reseller_name: 'Tienda Lupita', picked_up_at: expect.any(String) },
    ].sort((a, b) => a.serial.localeCompare(b.serial)));
    expect(JSON.stringify(res.body)).not.toMatch(MONEY_KEYS);
  });

  test('a pickup by the typed serial puts the bag in transit, and says nothing of the amount', async () => {
    const res = await post('/carrier-app/pickup', asCarrier(), { reseller_id: 1, serial: ' bag-106', latitude: 19.28, longitude: -99.65 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: 106, serial: 'BAG-106', status: 'in_transit', reseller_id: 1, reseller_name: 'Tienda Lupita', picked_up_at: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(MONEY_KEYS);
    expect(bagBySerial('BAG-106')).toMatchObject({ status: 'in_transit', carrier_user_id: CARRIER, picked_up_by: CARRIER });
    expect(state.events).toEqual([expect.objectContaining({ bag_id: 106, from_status: 'ready_for_pickup', to_status: 'in_transit', actor_user_id: CARRIER, latitude: 19.28, longitude: -99.65 })]);
    // The other organization's bag with the same serial is untouched.
    expect(bagBySerial('BAG-106', OTHER_ORG).status).toBe('ready_for_pickup');
    // Locked and re-checked inside the transaction.
    const [lock] = conn.execute.mock.calls.filter(([q]) => /FROM cash_bags/.test(q) && /FOR UPDATE/.test(q));
    expect(lock[0]).toMatch(/status = 'ready_for_pickup'/);
  });

  test.each([
    ['an unknown serial', { reseller_id: 1, serial: 'NOPE-1' }],
    ['a bag of another reseller', { reseller_id: 1, serial: 'BAG-108' }],
    ['an unassigned reseller', { reseller_id: 2, serial: 'BAG-108' }],
    ["another organization's reseller", { reseller_id: 9, serial: 'BAG-106' }],
    ['a bag that is not sealed', { reseller_id: 1, serial: 'BAG-105' }],
    ['a bag already on its way', { reseller_id: 1, serial: 'BAG-109' }],
  ])('%s is the same 404', async (_name, body) => {
    const before = clone(state.bags);
    const res = await post('/carrier-app/pickup', asCarrier(), body);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Bag not found');
    expect(state.bags).toEqual(before);
  });

  test('two carriers scanning the same bag: exactly one gets it', async () => {
    const first = await post('/carrier-app/pickup', asCarrier(), { reseller_id: 1, serial: 'BAG-106' });
    const second = await post('/carrier-app/pickup', asCarrier(CARRIER_PERMISSIONS, CARRIER_2), { reseller_id: 1, serial: 'BAG-106' });
    expect([first.status, second.status]).toEqual([200, 404]);
    expect(bagBySerial('BAG-106').carrier_user_id).toBe(CARRIER);
  });

  test('a drop-off leaves empty bags of its own stock at an assigned reseller', async () => {
    const res = await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 1, serials: ['bag-103'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reseller_id: 1, reseller_name: 'Tienda Lupita', bags: [{ serial: 'BAG-103', status: 'at_reseller' }] });
    expect(bagBySerial('BAG-103')).toMatchObject({ status: 'at_reseller', reseller_id: 1 });
  });

  test('a drop-off of a bag staff assigned to another point is refused; at its own point it is confirmed', async () => {
    state.assignments.push({ organization_id: ORG, carrier_user_id: CARRIER, reseller_id: 2 });
    Object.assign(bagBySerial('BAG-103'), { reseller_id: 2 });
    const wrong = await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 1, serials: ['BAG-103'] });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toMatchObject({ code: 'BAGS_FOR_ANOTHER_POINT', details: { failed: ['BAG-103'] } });
    expect(bagBySerial('BAG-103')).toMatchObject({ status: 'with_carrier', reseller_id: 2 });
    const right = await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 2, serials: ['BAG-103'] });
    expect(right.status).toBe(200);
    expect(bagBySerial('BAG-103')).toMatchObject({ status: 'at_reseller', reseller_id: 2 });
  });

  test("a drop-off is all or nothing, and another carrier's bag fails like an unknown one", async () => {
    const res = await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 1, serials: ['BAG-103', 'BAG-104', 'NOPE-9'] });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'BAGS_NOT_IN_YOUR_STOCK', details: { failed: ['BAG-104', 'NOPE-9'] } });
    expect(bagBySerial('BAG-103').status).toBe('with_carrier');
    expect(bagBySerial('BAG-104')).toMatchObject({ status: 'with_carrier', carrier_user_id: CARRIER_2 });
    expect(state.events).toHaveLength(0);
  });

  test('a drop-off at an unassigned reseller is a 404, and more than 50 serials a 422', async () => {
    expect((await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 2, serials: ['BAG-103'] })).status).toBe(404);
    const many = Array.from({ length: 51 }, (_v, i) => `S${i}`);
    expect((await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 1, serials: many })).status).toBe(422);
  });

  // The event row (and the drop-off's reseller_id) checks its foreign key with
  // a shared lock on the reseller row: taking the reseller first keeps the
  // order of a seal or receive of the same bag, so the two cannot deadlock.
  test('a pickup and a drop-off lock the reseller row before the bags', async () => {
    expect((await post('/carrier-app/pickup', asCarrier(), { reseller_id: 1, serial: 'BAG-106' })).status).toBe(200);
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
    conn.execute.mockClear();
    expect((await post('/carrier-app/dropoff', asCarrier(), { reseller_id: 1, serials: ['BAG-103'] })).status).toBe(200);
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
  });

  test('pickup and drop-off need carrier_app.pickup', async () => {
    const token = asCarrier(['carrier_app.use']);
    expect((await post('/carrier-app/pickup', token, { reseller_id: 1, serial: 'BAG-106' })).status).toBe(403);
    expect((await post('/carrier-app/dropoff', token, { reseller_id: 1, serials: ['BAG-103'] })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('sealing a bag (POST /reseller-app/bags/seal)', () => {
  // R1 collected 800 and sealed 500 in bags 106 and 109: it owes and holds 300, limit 1000.
  test('a bag staff assigned to the point may be sealed before the carrier confirms the delivery', async () => {
    Object.assign(bagBySerial('BAG-103'), { reseller_id: 1 });
    const res = await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-103', declared_amount: 100 });
    expect(res.status).toBe(200);
    expect(res.body.data.bag).toMatchObject({ serial: 'BAG-103', status: 'ready_for_pickup', declared_amount: 100 });
    expect(state.events).toEqual([expect.objectContaining({ bag_id: 103, from_status: 'with_carrier', to_status: 'ready_for_pickup', reseller_id: 1 })]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'cash_bag_seal', oldValues: { status: 'with_carrier' } }));
    // Another point's bag (or one with no point) is not its to seal.
    Object.assign(bagBySerial('BAG-104'), { reseller_id: 2 });
    expect((await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-104', declared_amount: 10 })).status).toBe(404);
  });

  test('posts one bag_sealed line of -declared: the balance drops by it at once', async () => {
    const res = await post('/reseller-app/bags/seal', asReseller(), { serial: 'bag-105', declared_amount: 250.5 });
    expect(res.status).toBe(200);
    expect(res.body.data.bag).toEqual({ id: 105, serial: 'BAG-105', status: 'ready_for_pickup', declared_amount: 250.5, sealed_at: expect.any(String), picked_up_at: null });
    expect(res.body.data.summary).toEqual({
      currency: 'MXN', balance: 49.5, in_bags: 750.5, cash_on_hand: 49.5, credit_limit: 1000, available_to_collect: 950.5, limit_reached: false,
      empty_bags: 0, bags_on_the_way: 0, bags_ready_for_pickup: 2, bags_in_transit: 1,
    });
    expect(state.ledger).toHaveLength(LEDGER_AT_START + 1);
    expect(state.ledger.filter((e) => e.cash_bag_id === 105)).toEqual([expect.objectContaining({
      organization_id: ORG, reseller_id: 1, entry_type: 'bag_sealed', amount: '-250.50', currency: 'MXN',
      payment_id: null, cash_session_id: null, note: 'Bolsa BAG-105 sellada', created_by: RESELLER_USER,
    })]);
    expect(fromCents(ledgerSum(1))).toBe('49.50');
    expect(state.events).toEqual([expect.objectContaining({ bag_id: 105, from_status: 'at_reseller', to_status: 'ready_for_pickup', amount: '250.50', actor_user_id: RESELLER_USER })]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cash_bag_seal', newValues: expect.objectContaining({ ledger_entry_ids: [LEDGER_AT_START + 6] }),
    }));
  });

  test('the bag_sealed line is posted inside the transaction that seals the bag, after the locks', async () => {
    await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 100 });
    const statements = conn.execute.mock.calls.map(([q]) => String(q));
    const insert = statements.findIndex((q) => /INSERT INTO reseller_ledger_entries/.test(q));
    const sealUpdate = statements.findIndex((q) => /UPDATE cash_bags SET status = 'ready_for_pickup'/.test(q));
    expect(insert).toBeGreaterThan(sealUpdate);
    expect(sealUpdate).toBeGreaterThan(-1);
    expect(db.query.mock.calls.some(([q]) => /INSERT INTO reseller_ledger_entries/.test(q))).toBe(false);
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  test('a refused seal posts no ledger line', async () => {
    await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 300.01 });
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
  });

  test('locks the reseller row before the bag', async () => {
    await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 100 });
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
  });

  test('more than the cash on hand is BAG_AMOUNT_EXCEEDS_CASH and changes nothing', async () => {
    const res = await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 300.01 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'BAG_AMOUNT_EXCEEDS_CASH', details: { cash_on_hand: 300, declared_amount: 300.01 } });
    expect(bagBySerial('BAG-105').status).toBe('at_reseller');
    expect(state.events).toHaveLength(0);
    // Exactly the cash on hand is allowed, and leaves the reseller owing nothing.
    expect((await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 300 })).status).toBe(200);
    expect(ledgerSum(1)).toBe(0);
  });

  test.each([[0], [-5], [10.005]])('a declared amount of %p is a 422', async (amount) => {
    expect((await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: amount })).status).toBe(422);
  });

  test("another reseller's bag, a sealed one or an unknown serial is a 404", async () => {
    for (const serial of ['BAG-107', 'BAG-106', 'NOPE']) {
      expect((await post('/reseller-app/bags/seal', asReseller(), { serial, declared_amount: 10 })).status).toBe(404);
    }
  });

  test("a sub-reseller's user fills its top-level reseller's bags", async () => {
    const res = await post('/reseller-app/bags/seal', asReseller(RESELLER_PERMISSIONS, SUB_RESELLER_USER), { serial: 'BAG-105', declared_amount: 20 });
    expect(res.status).toBe(200);
    expect(bagBySerial('BAG-105')).toMatchObject({ status: 'ready_for_pickup', sealed_by: SUB_RESELLER_USER, reseller_id: 1 });
  });

  test('needs reseller_app.bags, and org-level staff are refused', async () => {
    expect((await post('/reseller-app/bags/seal', asReseller(['reseller_app.use']), { serial: 'BAG-105', declared_amount: 10 })).status).toBe(403);
    expect((await post('/reseller-app/bags/seal', asAdmin([...ADMIN_PERMISSIONS, 'reseller_app.bags']), { serial: 'BAG-105', declared_amount: 10 })).status).toBe(403);
  });

  test('GET /reseller-app/bags lists only empty, sealed and travelling bags, and /me the bag money', async () => {
    state.bags.push(bag(160, 'OLD-1', 'received', { reseller_id: 1, declared_amount: '10.00', counted_amount: '10.00' }));
    state.bags.push(bag(161, 'OLD-2', 'void', { reseller_id: 1 }));
    state.bags.push(bag(162, 'OLD-3', 'lost', { reseller_id: 1, declared_amount: '5.00' }));
    const res = await get('/reseller-app/bags', asReseller());
    expect(res.status).toBe(200);
    expect(res.body.data.map((b) => [b.serial, b.status])).toEqual([['BAG-105', 'at_reseller'], ['BAG-106', 'ready_for_pickup'], ['BAG-109', 'in_transit']]);
    expect(res.body.summary).toMatchObject({ balance: 300, in_bags: 500, cash_on_hand: 300, empty_bags: 1, bags_ready_for_pickup: 1, bags_in_transit: 1 });
    const me = await get('/reseller-app/me', asReseller());
    expect(me.body.data.money).toMatchObject({ balance: 300, in_bags: 500, cash_on_hand: 300, credit_limit: 1000, available_to_collect: 700, empty_bags: 1, bags_ready_for_pickup: 1, bags_in_transit: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('receiving a bag (POST /cash-bags/:id/receive)', () => {
  const entries = () => state.ledger.filter((e) => e.cash_bag_id === 109).map((e) => [e.entry_type, e.amount, e.note]);

  const SEALED = ['bag_sealed', '-200.00', 'Bolsa BAG-109 sellada'];

  test('a bag that counts what was declared posts nothing more: its cash left the ledger at sealing', async () => {
    const res = await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 200 });
    expect(res.status).toBe(200);
    expect(entries()).toEqual([SEALED]);
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
    expect(res.body.data.bag).toMatchObject({ id: 109, status: 'received', declared_amount: 200, counted_amount: 200, variance: 0, reseller_name: 'Tienda Lupita' });
    expect(res.body.data.ledger_entries).toEqual([]);
    // Still 300 owed and held; bag 106 (300) is still in bags.
    expect(res.body.data.summary).toEqual({ balance: 300, in_bags: 300, cash_on_hand: 300, credit_limit: 1000, available_to_collect: 700, credit_limit_override: 1000 });
    expect(state.events).toEqual([expect.objectContaining({ from_status: 'in_transit', to_status: 'received', amount: '200.00', actor_user_id: ADMIN })]);
  });

  test('a short bag raises the debt by the difference, and only that', async () => {
    const res = await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 180.5, note: 'faltante' });
    expect(res.status).toBe(200);
    expect(entries()).toEqual([
      SEALED,
      ['adjustment', '19.50', 'Bolsa BAG-109: declarado 200.00, contado 180.50'],
    ]);
    expect(res.body.data.ledger_entries).toEqual([expect.objectContaining({ entry_type: 'adjustment', amount: 19.5, cash_bag_id: 109, cash_bag_serial: 'BAG-109' })]);
    expect(res.body.data.bag.variance).toBe(-19.5);
    // Net -180.50 over the bag's life: the reseller still owes the 19.50 it did not hand in.
    expect(res.body.data.summary).toMatchObject({ balance: 319.5, in_bags: 300, cash_on_hand: 319.5, available_to_collect: 680.5 });
  });

  test('an over bag lowers the debt', async () => {
    await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 210 });
    expect(entries()).toEqual([
      SEALED,
      ['adjustment', '-10.00', 'Bolsa BAG-109: declarado 200.00, contado 210.00'],
    ]);
    expect(fromCents(ledgerSum(1))).toBe('290.00');
  });

  test('a bag sealed before migration 006 with no bag_sealed line also gets the deposit, so it is counted once', async () => {
    state.ledger = state.ledger.filter((e) => e.cash_bag_id !== 109);
    expect(fromCents(ledgerSum(1))).toBe('500.00');
    const res = await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 200 });
    expect(res.status).toBe(200);
    expect(entries()).toEqual([['deposit', '-200.00', 'Bolsa BAG-109']]);
    expect(res.body.data.ledger_entries).toEqual([expect.objectContaining({ entry_type: 'deposit', amount: -200, cash_bag_serial: 'BAG-109' })]);
    expect(res.body.data.summary).toMatchObject({ balance: 300, cash_on_hand: 300 });
  });

  test('a legacy bag that comes up short gets the deposit and the difference', async () => {
    state.ledger = state.ledger.filter((e) => e.cash_bag_id !== 109);
    await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 150 });
    expect(entries()).toEqual([
      ['deposit', '-200.00', 'Bolsa BAG-109'],
      ['adjustment', '50.00', 'Bolsa BAG-109: declarado 200.00, contado 150.00'],
    ]);
    expect(fromCents(ledgerSum(1))).toBe('350.00');
  });

  test('a bag sealed in the app and then received nets the ledger to minus the count', async () => {
    const before = ledgerSum(1);
    expect((await post('/reseller-app/bags/seal', asReseller(), { serial: 'BAG-105', declared_amount: 120 })).status).toBe(200);
    expect(ledgerSum(1)).toBe(before - 12000);
    expect((await post('/cash-bags/105/receive', asAdmin(), { counted_amount: 115 })).status).toBe(200);
    expect(ledgerSum(1)).toBe(before - 11500);
    expect(state.ledger.filter((e) => e.cash_bag_id === 105).map((e) => [e.entry_type, e.amount]))
      .toEqual([['bag_sealed', '-120.00'], ['adjustment', '5.00']]);
  });

  test('a bag the reseller brought in person is received from ready_for_pickup, and says so', async () => {
    const res = await post('/cash-bags/106/receive', asAdmin(), { counted_amount: 300 });
    expect(res.status).toBe(200);
    expect(state.events).toEqual([expect.objectContaining({ from_status: 'ready_for_pickup', to_status: 'received', note: 'Entregada en persona por el revendedor' })]);
  });

  test('locks the reseller row before the bag', async () => {
    await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 200 });
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
  });

  test('an empty bag cannot be received, nor a received one twice', async () => {
    const empty = await post('/cash-bags/105/receive', asAdmin(), { counted_amount: 0 });
    expect(empty.status).toBe(409);
    expect(empty.body.error.code).toBe('BAG_INVALID_TRANSITION');
    expect((await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 200 })).status).toBe(200);
    expect((await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 200 })).status).toBe(409);
    expect(entries()).toEqual([SEALED]);
  });

  test("another organization's bag is a 404, and the count needs cash_bags.receive", async () => {
    expect((await post('/cash-bags/901/receive', asAdmin(), { counted_amount: 10 })).status).toBe(404);
    expect((await post('/cash-bags/109/receive', asAdmin(['cash_bags.view', 'cash_bags.manage']), { counted_amount: 200 })).status).toBe(403);
    expect((await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 1.001 })).status).toBe(422);
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
  });
});

// ---------------------------------------------------------------------------
describe('void, lost and return', () => {
  test('a bag lost in transit posts nothing: the reseller does not owe it again, the ISP absorbs it', async () => {
    const res = await post('/cash-bags/109/lost', asAdmin(), { reason: 'asalto en ruta' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'lost', declared_amount: 200 });
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
    const me = await get('/reseller-app/me', asReseller());
    expect(me.body.data.money).toMatchObject({ balance: 300, in_bags: 300, cash_on_hand: 300, available_to_collect: 700 });
  });

  test('a bag lost while waiting at the reseller posts nothing either, and the balance stays reduced', async () => {
    const res = await post('/cash-bags/106/lost', asAdmin(), { reason: 'robo en la tienda' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('lost');
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
    const ledger = await get('/resellers/1/ledger', asAdmin());
    expect(ledger.body.summary).toMatchObject({ balance: 300, in_bags: 200, cash_on_hand: 300, available_to_collect: 700 });
  });

  test.each([['in_stock', 101], ['with_carrier', 103], ['at_reseller', 105]])('a bag %s can be voided', async (_status, id) => {
    const res = await post(`/cash-bags/${id}/void`, asAdmin(), { reason: 'bolsa rota' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('void');
    expect(state.events).toEqual([expect.objectContaining({ bag_id: id, to_status: 'void', note: 'bolsa rota' })]);
  });

  test('a bag with money in it cannot be voided, nor one without lost', async () => {
    for (const id of [106, 109]) expect((await post(`/cash-bags/${id}/void`, asAdmin(), { reason: 'bolsa rota' })).status).toBe(409);
    for (const id of [101, 103, 105]) expect((await post(`/cash-bags/${id}/lost`, asAdmin(), { reason: 'perdida' })).status).toBe(409);
    expect((await post('/cash-bags/101/void', asAdmin(), { reason: 'no' })).status).toBe(422);
    expect((await post('/cash-bags/101/void', asAdmin(), { reason: '   x   ' })).status).toBe(422);
  });

  test('void and return of a bag at a reseller lock the reseller row first; a bag without one locks only the bag', async () => {
    expect((await post('/cash-bags/105/void', asAdmin(), { reason: 'bolsa rota' })).status).toBe(200);
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
    conn.execute.mockClear();
    expect((await post('/cash-bags/107/return', asAdmin(), { reason: 'la tienda cerró' })).status).toBe(200);
    expect(lockOrder()).toEqual(['resellers', 'cash_bags']);
    conn.execute.mockClear();
    expect((await post('/cash-bags/101/void', asAdmin(), { reason: 'bolsa rota' })).status).toBe(200);
    expect(lockOrder()).toEqual(['cash_bags']);
  });

  test('a bag that changed reseller between the read and the lock is a 409 BAG_CHANGED, untouched', async () => {
    // Bag 103 is with the carrier (no reseller) when it is read, and dropped
    // off at reseller 1 before the transaction locks it.
    conn.beginTransaction.mockImplementation(async () => {
      snapshot = clone(state);
      Object.assign(bagBySerial('BAG-103'), { status: 'at_reseller', reseller_id: 1 });
    });
    const res = await post('/cash-bags/103/void', asAdmin(), { reason: 'bolsa rota' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BAG_CHANGED');
    expect(bagBySerial('BAG-103').status).toBe('with_carrier');
  });

  test('a carrier hands stock back, or takes an empty bag back', async () => {
    Object.assign(bagBySerial('BAG-103'), { reseller_id: 1 });
    const back = await post('/cash-bags/103/return', asAdmin(), {});
    // Back in stock it is nobody's: its point is cleared.
    expect(back.body.data).toMatchObject({ status: 'in_stock', carrier_user_id: null, reseller_id: null });
    const taken = await post('/cash-bags/105/return', asAdmin(), { reason: 'la tienda cerró' });
    expect(taken.body.data).toMatchObject({ status: 'with_carrier', reseller_id: null, carrier_user_id: CARRIER });
    expect((await post('/cash-bags/106/return', asAdmin(), {})).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('staff reads and the ledger', () => {
  test('GET /cash-bags filters by status list, reseller and serial, with names and variance', async () => {
    state.bags.push(bag(170, 'DIF-1', 'received', { reseller_id: 1, declared_amount: '100.00', counted_amount: '90.00' }));
    const res = await get('/cash-bags?status=ready_for_pickup,in_transit&reseller_id=1', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data.map((b) => b.serial).sort()).toEqual(['BAG-106', 'BAG-109']);
    expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 25 });
    expect(res.body.data.find((b) => b.serial === 'BAG-109')).toMatchObject({ reseller_name: 'Tienda Lupita', carrier_name: 'Carlos Ruta', declared_amount: 200, variance: null });
    const diff = await get('/cash-bags?has_variance=1', asAdmin());
    expect(diff.body.data).toEqual([expect.objectContaining({ serial: 'DIF-1', variance: -10 })]);
    expect((await get('/cash-bags?serial=dif', asAdmin())).body.data.map((b) => b.serial)).toEqual(['DIF-1']);
    expect((await get('/cash-bags?status=bogus', asAdmin())).status).toBe(422);
  });

  test('GET /cash-bags/summary counts per status and totals the differences per reseller', async () => {
    state.bags.push(bag(170, 'DIF-1', 'received', { reseller_id: 1, declared_amount: '100.00', counted_amount: '90.00' }));
    state.bags.push(bag(171, 'DIF-2', 'received', { reseller_id: 1, declared_amount: '50.00', counted_amount: '55.00' }));
    const res = await get('/cash-bags/summary', asAdmin());
    expect(res.body.data.counts).toMatchObject({ in_stock: 2, with_carrier: 2, at_reseller: 2, ready_for_pickup: 2, in_transit: 1, received: 2, void: 0, lost: 0 });
    expect(res.body.data.in_bags).toBe(550);
    expect(res.body.data.resellers).toEqual([{
      reseller_id: 1, reseller_name: 'Tienda Lupita', received_bags: 2, bags_with_difference: 2,
      declared_total: 150, counted_total: 145, variance: -5,
    }]);
  });

  test('GET /cash-bags/:id carries the history', async () => {
    await post('/carrier-app/pickup', asCarrier(), { reseller_id: 1, serial: 'BAG-106' });
    const res = await get('/cash-bags/106', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([expect.objectContaining({ from_status: 'ready_for_pickup', to_status: 'in_transit', actor_name: 'Carlos Ruta', reseller_name: 'Tienda Lupita' })]);
    expect((await get('/cash-bags/901', asAdmin())).status).toBe(404);
  });

  test('GET /resellers/:id/bags lists its bags with history and its variance', async () => {
    state.bags.push(bag(170, 'DIF-1', 'received', { reseller_id: 1, declared_amount: '100.00', counted_amount: '90.00' }));
    const res = await get('/resellers/1/bags', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data.map((b) => b.serial).sort()).toEqual(['BAG-105', 'BAG-106', 'BAG-109', 'DIF-1']);
    expect(res.body.data[0]).toHaveProperty('events');
    expect(res.body.summary).toMatchObject({ in_bags: 500, received_bags: 1, variance: -10, counts: expect.objectContaining({ received: 1 }) });
  });

  test('the reseller rows and the staff ledger carry in_bags and cash_on_hand, and a deposit is capped at the cash on hand', async () => {
    const one = await get('/resellers/1', asAdmin());
    expect(one.body.data).toMatchObject({ balance: 300, in_bags: 500, cash_on_hand: 300, effective_credit_limit: 1000, available_to_collect: 700 });
    const list = await get('/resellers', asAdmin());
    expect(list.body.data.find((r) => r.id === 2)).toMatchObject({ balance: 0, in_bags: 50, cash_on_hand: 0 });
    const ledger = await get('/resellers/1/ledger', asAdmin());
    expect(ledger.body.summary).toMatchObject({ balance: 300, in_bags: 500, cash_on_hand: 300 });
    // The 500 in bags already left the balance when they were sealed.
    const tooMuch = await post('/resellers/1/ledger', asAdmin(), { entry_type: 'deposit', amount: 300.01 });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('DEPOSIT_EXCEEDS_BALANCE');
    expect(tooMuch.body.error.message).toMatch(/300\.00 in cash;/);
    expect((await post('/resellers/1/ledger', asAdmin(), { entry_type: 'deposit', amount: 300 })).status).toBe(201);
    expect(ledgerSum(1)).toBe(0);
  });

  test('staff cannot post a bag_sealed line, or any type but a deposit or an adjustment, by hand', async () => {
    for (const entryType of ['bag_sealed', 'collection', 'collection_void']) {
      const res = await post('/resellers/1/ledger', asAdmin(), { entry_type: entryType, amount: -10, note: 'a mano' });
      expect([entryType, res.status]).toEqual([entryType, 422]);
    }
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
  });

  test("PUT /resellers/:id clears the carrier's address and pin when they are sent empty, and keeps them when absent", async () => {
    const token = asAdmin([...ADMIN_PERMISSIONS, 'resellers.update']);
    const keep = await put('/resellers/1', token, { name: 'Tienda Lupita' });
    expect(keep.status).toBe(200);
    expect(state.resellers[1]).toMatchObject({ address: 'Av. Juárez 10', city: 'Toluca', latitude: '19.2826000', longitude: '-99.6557000' });
    const cleared = await put('/resellers/1', token, { address: '', city: null, latitude: null, longitude: null });
    expect(cleared.status).toBe(200);
    expect(state.resellers[1]).toMatchObject({ address: null, city: null, latitude: null, longitude: null });
    // The carrier is no longer sent to the old place.
    const seen = await get('/carrier-app/resellers', asCarrier());
    expect(seen.body.data[0]).toMatchObject({ address: null, city: null, latitude: null, longitude: null });
    const again = asAdmin([...ADMIN_PERMISSIONS, 'resellers.update']);
    const moved = await put('/resellers/1', again, { address: ' Calle 5 ', latitude: 19.3, longitude: -99.6 });
    expect(moved.status).toBe(200);
    expect(state.resellers[1]).toMatchObject({ address: 'Calle 5', city: null, latitude: 19.3, longitude: -99.6 });
    expect((await put('/resellers/1', again, { latitude: null })).status).toBe(422);
    expect((await put('/resellers/1', again, { latitude: 19.3, longitude: null })).status).toBe(422);
  });

  test('a received bag names itself on its ledger lines', async () => {
    await post('/cash-bags/109/receive', asAdmin(), { counted_amount: 190 });
    const ledger = await get('/resellers/1/ledger', asAdmin());
    expect(ledger.body.data.filter((e) => e.cash_bag_id === 109).map((e) => [e.entry_type, e.cash_bag_serial]))
      .toEqual([['adjustment', 'BAG-109'], ['bag_sealed', 'BAG-109']]);
    const app2 = await get('/reseller-app/ledger', asReseller());
    expect(app2.body.data.filter((e) => e.cash_bag_serial === 'BAG-109')).toHaveLength(2);
  });

  test('the staff endpoints refuse reseller-bound users and carriers', async () => {
    const reseller = asReseller();
    for (const [method, path] of [['get', '/cash-bags'], ['post', '/cash-bags/109/receive'], ['get', '/carriers'], ['get', '/resellers/1/bags']]) {
      const res = method === 'get' ? await get(path, reseller) : await post(path, reseller, { counted_amount: 1 });
      expect([path, res.status]).toEqual([path, 403]);
    }
    const carrier = asCarrier([...CARRIER_PERMISSIONS, 'cash_bags.receive']);
    expect((await post('/cash-bags/109/receive', carrier, { counted_amount: 1 })).status).toBe(403);
    expect(state.ledger).toHaveLength(LEDGER_AT_START);
  });

  test('the router guard refuses a bound user even without the fence', async () => {
    const router = require('../src/routes/cashBags');
    const guard = router.stack.find((l) => l.name === 'requireOrgStaff');
    const next = jest.fn();
    await guard.handle({ resellerScope: { all: false, rootId: 1, resellerIds: [1] }, user: { id: RESELLER_USER } }, {}, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  });
});

// ---------------------------------------------------------------------------
describe('carriers (staff)', () => {
  test('GET /carriers lists them with their resellers and bags in hand', async () => {
    const res = await get('/carriers', asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ user_id: CARRIER, first_name: 'Carlos', resellers: [{ id: 1, name: 'Tienda Lupita' }], bags_in_hand: { with_carrier: 1, in_transit: 1 } }),
      expect.objectContaining({ user_id: CARRIER_2, resellers: [{ id: 1, name: 'Tienda Lupita' }], bags_in_hand: { with_carrier: 1, in_transit: 0 } }),
    ]);
  });

  test('POST /carriers creates a login in the carrier group, with the password policy', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 80 });
    const creator = asAdmin([...ADMIN_PERMISSIONS, 'users.create']);
    const res = await post('/carriers', creator, { first_name: 'Pedro', last_name: 'Moto', email: 'pedro@example.com', password: 'Moto-2026-ruta', phone: '722 000 0080' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ user_id: 80, first_name: 'Pedro', last_name: 'Moto', email: 'pedro@example.com', phone: '722 000 0080' });
    const [[created]] = User.create.mock.calls;
    expect(created).toMatchObject({ organization_id: ORG, group_id: CARRIER_GROUP, status: 'active', email: 'pedro@example.com' });
    expect(created.password_hash).not.toBe('Moto-2026-ruta');
    expect((await post('/carriers', creator, { first_name: 'P', last_name: 'M', email: 'p2@example.com', password: 'short' })).status).toBe(422);
    User.findByEmail.mockResolvedValue({ id: 3 });
    expect((await post('/carriers', creator, { first_name: 'P', last_name: 'M', email: 'pedro@example.com', password: 'Moto-2026-ruta' })).status).toBe(409);
  });

  test('point_logins.create (manager) is enough to create a carrier login, without users.create', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 81 });
    const res = await post('/carriers', asAdmin(['carriers.manage', 'point_logins.create']), { first_name: 'Ana', last_name: 'Ruta', email: 'ana@example.com', password: 'Moto-2026-ruta' });
    expect(res.status).toBe(201);
    expect(User.create.mock.calls[0][0]).toMatchObject({ group_id: CARRIER_GROUP });
  });

  test('creating a carrier login needs users.create (or point_logins.create) as well as carriers.manage', async () => {
    User.findByEmail.mockResolvedValue(null);
    User.create.mockResolvedValue({ id: 80 });
    const res = await post('/carriers', asAdmin(['carriers.manage']), { first_name: 'Pedro', last_name: 'Moto', email: 'pedro@example.com', password: 'Moto-2026-ruta' });
    expect(res.status).toBe(403);
    expect(User.create).not.toHaveBeenCalled();
    // carriers.manage alone still lists and assigns.
    expect((await get('/carriers', asAdmin(['carriers.manage']))).status).toBe(200);
    expect((await put(`/carriers/${CARRIER}/resellers`, asAdmin(['carriers.manage']), { reseller_ids: [2] })).status).toBe(200);
  });

  test('GET /carriers/assignable-resellers lists every live top-level reseller of the organization with carriers.manage alone', async () => {
    state.resellers[4] = { id: 4, organization_id: ORG, parent_id: null, level: 1, name: 'Archivada', status: 'active', credit_limit: null, deleted_at: new Date() };
    const res = await get('/carriers/assignable-resellers', asAdmin(['carriers.manage']));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ id: 2, name: 'Papelería Sol', city: null }, { id: 1, name: 'Tienda Lupita', city: 'Toluca' }],
      meta: { total: 2, truncated: false },
    });
    expect((await get('/carriers/assignable-resellers', asAdmin(['resellers.view']))).status).toBe(403);
    expect((await get('/carriers/assignable-resellers', asReseller([...RESELLER_PERMISSIONS, 'carriers.manage']))).status).toBe(403);
    expect((await get('/carriers/assignable-resellers', asCarrier([...CARRIER_PERMISSIONS, 'carriers.manage']))).status).toBe(403);
  });

  test('PUT /carriers/:userId/resellers replaces the set with top-level resellers of the organization only', async () => {
    const ok = await put(`/carriers/${CARRIER}/resellers`, asAdmin(), { reseller_ids: [2, 1] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.map((r) => r.id)).toEqual([2, 1].sort((a, b) => state.resellers[a].name.localeCompare(state.resellers[b].name)));
    expect(state.assignments.filter((a) => a.carrier_user_id === CARRIER).map((a) => a.reseller_id).sort()).toEqual([1, 2]);
    for (const ids of [[3], [9], [404]]) {
      expect((await put(`/carriers/${CARRIER}/resellers`, asAdmin(), { reseller_ids: ids })).status).toBe(422);
    }
    expect((await put(`/carriers/${RESELLER_USER}/resellers`, asAdmin(), { reseller_ids: [1] })).status).toBe(404);
    expect((await get(`/carriers/${RESELLER_USER}/resellers`, asAdmin())).status).toBe(404);
    const cleared = await put(`/carriers/${CARRIER}/resellers`, asAdmin(), { reseller_ids: [] });
    expect(cleared.body.data).toEqual([]);
  });

  test('needs carriers.manage', async () => {
    expect((await get('/carriers', asAdmin(['cash_bags.view']))).status).toBe(403);
  });
});
