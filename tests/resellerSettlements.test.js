// =============================================================================
// Reseller program, phase 5 (migration 008): statements and settlement
// =============================================================================
// A statement closes a period of a top-level reseller's cash ledger; its
// figures are rebuilt from the ledger. Staff generate (after the commission
// gap sweep), approve and settle it; the reseller sees its approved and
// settled statements in the reseller app. The database is an in-memory fake
// with transaction snapshots, so a rollback really discards what the
// transaction wrote.
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

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const { handleCommissionSql, ledgerCents } = require('./helpers/commissionFakeDb');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const settlements = require('../src/services/resellerSettlementService');
const commissions = require('../src/services/resellerCommissionService');
const app = require('../src/app');

const ORG = 1;
const USER = 7;
const TODAY = '2026-11-08';
const NOW = new Date('2026-11-08T18:00:00Z');
const OCT = settlements.periodBounds('2026-10-01', '2026-10-31');
const NOV = settlements.periodBounds('2026-11-01', '2026-11-30');
const HOUR = 3600 * 1000;
const at = (base, ms) => new Date(base.getTime() + ms);

const cents = (v) => Math.round(Number(v) * 100);
const clone = (v) => structuredClone(v);

let state;
let snapshot;
let binding;
let groupName;

function freshState() {
  return {
    resellers: {
      1: { id: 1, organization_id: ORG, parent_id: null, name: 'Tienda Lupita', status: 'active', commission_rate: '10.00', credit_limit: null, deleted_at: null },
      2: { id: 2, organization_id: ORG, parent_id: null, name: 'Papelería Sol', status: 'active', commission_rate: '5.00', credit_limit: null, deleted_at: null },
      3: { id: 3, organization_id: ORG, parent_id: 1, name: 'Lupita Norte', status: 'active', commission_rate: '0.00', credit_limit: null, deleted_at: null },
    },
    clients: {},
    invoices: {},
    commissions: [],
    ledger: [],
    settlements: [],
    seq: { ledger: 100, settlement: 0, commission: 0 },
  };
}

function line(resellerId, entryType, amount, createdAt) {
  const id = ++state.seq.ledger;
  state.ledger.push({
    id, organization_id: ORG, reseller_id: resellerId, entry_type: entryType, amount: Number(amount).toFixed(2), currency: 'MXN',
    payment_id: null, cash_session_id: null, cash_bag_id: null, invoice_id: null, commission_id: null, note: null,
    created_by: USER, created_at: createdAt,
  });
  return id;
}

const inRange = (e, from, to) => (!from || e.created_at >= from) && (!to || e.created_at < to);
const fromCents = (c) => (c / 100).toFixed(2);

// UPDATE reseller_settlements SET a = ?, b = CURRENT_TIMESTAMP, status = 'x' WHERE id = ? AND organization_id = ? AND status = 'y'
function updateSettlement(s, params) {
  const m = s.match(/UPDATE reseller_settlements\s+SET (.+?)\s+WHERE id = \? AND organization_id = \? AND status = '(\w+)'/);
  const sets = m[1].split(/,\s*/);
  const values = [...params];
  const changes = {};
  for (const set of sets) {
    const [col, rhs] = set.split(/\s*=\s*/);
    if (rhs === '?') changes[col] = values.shift();
    else if (rhs === 'CURRENT_TIMESTAMP') changes[col] = new Date();
    else changes[col] = rhs.replace(/'/g, '');
  }
  const [id, org] = values.map(Number);
  const row = state.settlements.find((x) => x.id === id && x.organization_id === org && x.status === m[2]);
  if (row) Object.assign(row, changes);
  return [{ affectedRows: row ? 1 : 0 }];
}

function withName(row) {
  return { ...row, reseller_name: state.resellers[row.reseller_id]?.name };
}

function handle(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  // --- identity and scope
  if (/FROM reseller_user_bindings b/.test(s)) return [binding ? [binding] : []];
  if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) return [groupName ? [{ group_name: groupName }] : []];
  if (/FROM resellers WHERE organization_id = \? AND parent_id IN/.test(s)) {
    const parents = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => parents.includes(r.parent_id)).map((r) => ({ id: r.id }))];
  }
  if (/SELECT currency FROM organizations/.test(s)) return [[{ currency: 'MXN' }]];
  if (/SELECT name, email, phone, address, city, state FROM organizations/.test(s)) return [[{ name: 'ISP Ejemplo', email: 'hola@example.com' }]];
  if (/FROM organization_settings WHERE organization_id = \? AND setting_key = 'reseller_default_credit_limit'/.test(s)) return [[]];
  // the sweep's subtree
  if (/SELECT id FROM resellers WHERE organization_id = \? AND deleted_at IS NULL AND \(id = \? OR parent_id = \?\)/.test(s)) {
    const root = Number(params[1]);
    return [Object.values(state.resellers).filter((r) => !r.deleted_at && (r.id === root || r.parent_id === root)).map((r) => ({ id: r.id }))];
  }
  if (/^SELECT \* FROM resellers WHERE id = \? AND organization_id = \?/.test(s)) {
    const r = state.resellers[Number(params[0])];
    return [r && !r.deleted_at ? [{ ...r }] : []];
  }
  // --- the sweep's candidates
  if (/SELECT i\.id FROM invoices i JOIN clients c/.test(s)) {
    const since = params[1];
    const rids = params.slice(2).map(Number);
    return [Object.values(state.invoices).filter((i) => i.status === 'paid' && !i.deleted_at && i.paid_at && i.paid_at >= since
      && rids.includes(state.clients[i.client_id]?.reseller_id)
      && !state.commissions.some((c) => c.invoice_id === i.id && c.reversed_at === null))
      .map((i) => ({ id: i.id }))];
  }
  if (/SELECT DISTINCT rc\.invoice_id FROM reseller_commissions rc JOIN invoices i/.test(s)) {
    const rid = Number(params[1]);
    return [[...new Set(state.commissions.filter((c) => c.reseller_id === rid && c.reversed_at === null)
      .filter((c) => { const i = state.invoices[c.invoice_id]; return i && (i.status !== 'paid' || i.deleted_at); })
      .map((c) => c.invoice_id))].map((invoice_id) => ({ invoice_id }))];
  }
  // --- ledger figures
  if (/AS balance FROM reseller_ledger_entries WHERE organization_id = \? AND reseller_id = \?$/.test(s)) {
    return [[{ balance: fromCents(ledgerCents(state, Number(params[1]))) }]];
  }
  if (/FROM cash_bags/.test(s)) return [[{ in_bags: '0.00' }]];
  if (/AS opening FROM reseller_ledger_entries/.test(s)) {
    const rid = Number(params[1]);
    const total = state.ledger.filter((e) => e.reseller_id === rid && inRange(e, null, params[2])).reduce((t, e) => t + cents(e.amount), 0);
    return [[{ opening: fromCents(total) }]];
  }
  if (/GROUP BY entry_type/.test(s)) {
    const rid = Number(params[1]);
    const by = {};
    for (const e of state.ledger.filter((x) => x.reseller_id === rid && inRange(x, params[2], params[3]))) {
      by[e.entry_type] = by[e.entry_type] || { entry_type: e.entry_type, total: 0, n: 0 };
      by[e.entry_type].total += cents(e.amount);
      by[e.entry_type].n += 1;
    }
    return [Object.values(by).map((r) => ({ ...r, total: fromCents(r.total) }))];
  }
  if (/FROM reseller_ledger_entries WHERE organization_id = \? AND reseller_id = \? AND created_at >= \? AND created_at < \?/.test(s)) {
    const rows = state.ledger.filter((e) => e.reseller_id === Number(params[1]) && inRange(e, params[2], params[3]))
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
    if (/COUNT\(\*\) AS total/.test(s)) return [[{ total: rows.length }]];
    const lim = s.match(/LIMIT (\d+) OFFSET (\d+)/);
    return [lim ? rows.slice(Number(lim[2]), Number(lim[2]) + Number(lim[1])) : rows];
  }
  // --- statements
  if (/FROM reseller_settlements WHERE organization_id = \? AND reseller_id = \? AND status <> 'void' AND period_start <= \? AND period_end >= \?/.test(s)) {
    const [, rid, end, start] = params;
    return [state.settlements.filter((x) => x.reseller_id === Number(rid) && x.status !== 'void' && x.period_start <= end && x.period_end >= start)];
  }
  if (/^INSERT INTO reseller_settlements/.test(s)) {
    const cols = s.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim());
    const row = { id: ++state.seq.settlement, generated_at: new Date() };
    let p = 0;
    for (const col of cols) row[col] = col === 'status' ? 'draft' : params[p++];
    row.organization_id = Number(row.organization_id);
    row.reseller_id = Number(row.reseller_id);
    for (const k of ['approved_by', 'approved_at', 'settled_by', 'settled_at', 'bank_ref', 'settlement_entry_id', 'voided_at']) row[k] = row[k] ?? null;
    state.settlements.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE reseller_settlements/.test(s)) return updateSettlement(s, params);
  if (/^SELECT s\.\* FROM reseller_settlements s WHERE s\.id = \?/.test(s)
    || /FROM reseller_settlements s JOIN resellers r ON r\.id = s\.reseller_id AND r\.organization_id = s\.organization_id WHERE s\.id = \?/.test(s)) {
    const [id, org, rid] = params.map(Number);
    const row = state.settlements.find((x) => x.id === id && x.organization_id === org && x.reseller_id === rid);
    return [row ? [withName(row)] : []];
  }
  if (/FROM reseller_settlements s JOIN resellers r .* WHERE s\.organization_id = \? AND s\.reseller_id = \?/.test(s)
    || /^SELECT COUNT\(\*\) AS total FROM reseller_settlements s WHERE/.test(s)) {
    const rid = Number(params[1]);
    const statuses = params.slice(2);
    const rows = state.settlements.filter((x) => x.reseller_id === rid && (!statuses.length || statuses.includes(x.status)))
      .sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
    if (/COUNT\(\*\)/.test(s)) return [[{ total: rows.length }]];
    return [rows.map(withName)];
  }
  const commissionAnswer = handleCommissionSql(state, s, params);
  if (commissionAnswer !== undefined) return commissionAnswer;
  return [[]];
}

const mockQuery = jest.fn(async (sql, params) => handle(sql, params));
let conn;

function tokenFor(role) {
  return jwt.sign({ sub: USER, email: `${role}@example.com`, role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}
const STAFF = ['resellers.view', 'reseller_settlements.view', 'reseller_settlements.manage', 'reseller_settlements.approve', 'reseller_ledger.view'];
function asStaff(permissions = STAFF) {
  groupName = 'admin';
  binding = undefined;
  User.findById.mockResolvedValue({ id: USER, email: 'a@example.com', status: 'active', role: 'support', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('support');
}
function asReseller(resellerId = 1, permissions = ['reseller_app.use', 'reseller_app.statements']) {
  groupName = 'reseller_admin';
  binding = { reseller_id: resellerId, live_reseller_id: resellerId, reseller_name: state.resellers[resellerId].name };
  User.findById.mockResolvedValue({ id: USER, email: 'r@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('billing');
}
const auth = (r, token) => r.set('Authorization', `Bearer ${token}`);
const get = (p, token) => auth(request(app).get(`/api/v1${p}`), token);
const post = (p, token, body = {}) => auth(request(app).post(`/api/v1${p}`), token).send(body);

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.resetAllMocks();
  state = freshState();
  snapshot = null;
  binding = undefined;
  groupName = undefined;
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
afterEach(() => jest.restoreAllMocks());

const noSweep = () => jest.spyOn(commissions, 'sweepCommissionGaps')
  .mockResolvedValue({ earned: 0, restored: 0, reversed: 0, unchanged: 0, failed: 0, truncated: false });

// A September line, then October lines of every type, then a November line.
function seedLedger() {
  line(1, 'collection', 500, at(OCT.startUtc, -10 * 24 * HOUR));   // opening
  line(1, 'collection', 1000, at(OCT.startUtc, 2 * 24 * HOUR));
  line(1, 'collection_void', -50, at(OCT.startUtc, 2 * 24 * HOUR + HOUR));
  line(1, 'bag_sealed', -600, at(OCT.startUtc, 5 * 24 * HOUR));
  line(1, 'adjustment', 10, at(OCT.startUtc, 6 * 24 * HOUR));
  line(1, 'commission', -95.5, at(OCT.startUtc, 7 * 24 * HOUR));
  line(1, 'commission_reversal', 20, at(OCT.startUtc, 8 * 24 * HOUR));
  line(1, 'deposit', -300, at(OCT.startUtc, 9 * 24 * HOUR));
  line(1, 'payout', 15.5, at(OCT.endUtc, -HOUR));                   // last hour of October
  line(1, 'collection', 77, at(OCT.endUtc, 0));                       // first instant of November
  line(2, 'collection', 999, at(OCT.startUtc, HOUR));                 // another reseller
}

// =============================================================================
describe('periods', () => {
  test('the default period is the previous business month', () => {
    expect(settlements.defaultPeriod('2026-11-08')).toEqual({ period_start: '2026-10-01', period_end: '2026-10-31' });
    expect(settlements.defaultPeriod('2026-01-15')).toEqual({ period_start: '2025-12-01', period_end: '2025-12-31' });
    expect(settlements.defaultPeriod('2028-03-01')).toEqual({ period_start: '2028-02-01', period_end: '2028-02-29' });
  });

  test.each([
    ['2026-10-31', '2026-10-01', 'PERIOD_INVALID'],
    ['2026-10-01', TODAY, 'PERIOD_NOT_ENDED'],
    ['2026-11-01', '2026-11-30', 'PERIOD_NOT_ENDED'],
    ['2026-02-30', '2026-03-31', 'VALIDATION_ERROR'],
    ['2024-01-01', '2025-06-30', 'PERIOD_TOO_LONG'],
  ])('%s to %s is refused with %s', (start, end, code) => {
    expect(() => settlements.assertPeriod(start, end, TODAY)).toThrow(expect.objectContaining({ code }));
  });

  test('a period that ended yesterday is accepted', () => {
    expect(() => settlements.assertPeriod('2026-11-01', '2026-11-07', TODAY)).not.toThrow();
  });

  test('bounds are the business days, half-open', () => {
    expect(OCT.endUtc.getTime()).toBe(settlements.periodBounds('2026-11-01', '2026-11-01').startUtc.getTime());
    expect(OCT.startUtc < OCT.endUtc).toBe(true);
  });
});

describe('figures, rebuilt from the ledger', () => {
  test('closing = opening + collections - voids - bags - commissions + reversals - deposits + payouts + adjustments', async () => {
    seedLedger();
    const f = await settlements.computeFigures(mockQuery, ORG, 1, '2026-10-01', '2026-10-31');
    expect(f.opening_balance).toBe(500);
    expect(f.totals).toEqual({
      collection: 1000, collection_void: -50, deposit: -300, adjustment: 10, bag_sealed: -600,
      commission: -95.5, commission_reversal: 20, payout: 15.5,
    });
    expect(f.entry_count).toBe(8);
    expect(f.closing_balance).toBe(500 + 1000 - 50 - 600 + 10 - 95.5 + 20 - 300 + 15.5);
    // The closing of October is the opening of November, and the ledger balance
    // is the closing of the last period plus what came after.
    const nov = await settlements.computeFigures(mockQuery, ORG, 1, '2026-11-01', '2026-11-07');
    expect(nov.opening_balance).toBe(f.closing_balance);
    expect(cents(nov.closing_balance)).toBe(ledgerCents(state, 1));
  });

  test('every ledger entry type has a statement total and a column in the migration', () => {
    const migration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '008_reseller_settlements.sql'), 'utf8');
    for (const type of require('../src/services/resellerLedgerService').ENTRY_TYPES) {
      expect(settlements.TOTAL_TYPES).toContain(type);
      expect(migration).toMatch(new RegExp(`\\btotal_${type}\\b`));
    }
  });

  test('an entry type without a total is refused rather than dropped from the closing', async () => {
    line(1, 'collection', 1, at(OCT.startUtc, HOUR));
    state.ledger[0].entry_type = 'mystery';
    await expect(settlements.computeFigures(mockQuery, ORG, 1, '2026-10-01', '2026-10-31')).rejects.toThrow(/without a statement total/);
  });
});

describe('staff: generate, approve, settle', () => {
  test('generating runs the gap sweep first, then stores a draft with the figures', async () => {
    seedLedger();
    const order = [];
    jest.spyOn(commissions, 'sweepCommissionGaps').mockImplementation(async () => {
      order.push('sweep');
      return { earned: 2, restored: 1, reversed: 1, unchanged: 0, failed: 0, truncated: false };
    });
    const token = asStaff();
    const res = await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' });
    expect(res.status).toBe(201);
    expect(order).toEqual(['sweep']);
    expect(res.body.data).toMatchObject({
      reseller_id: 1, reseller_name: 'Tienda Lupita', period_start: '2026-10-01', period_end: '2026-10-31', status: 'draft',
      opening_balance: 500, closing_balance: 500, entry_count: 8, sweep_earned: 3, sweep_reversed: 1, currency: 'MXN',
    });
    expect(res.body.sweep).toMatchObject({ earned: 2, restored: 1, reversed: 1 });
  });

  test('without a period it closes the previous month', async () => {
    noSweep();
    const res = await post('/resellers/1/settlements', asStaff(), {});
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ period_start: '2026-10-01', period_end: '2026-10-31' });
  });

  test('statements of one reseller never overlap; a discarded draft frees its period', async () => {
    noSweep();
    const token = asStaff();
    const first = await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' });
    const overlap = await post('/resellers/1/settlements', token, { period_start: '2026-10-31', period_end: '2026-11-05' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('SETTLEMENT_PERIOD_OVERLAP');
    // Another reseller is not affected.
    expect((await post('/resellers/2/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).status).toBe(201);
    const discarded = await post(`/resellers/1/settlements/${first.body.data.id}/discard`, token);
    expect(discarded.status).toBe(200);
    expect(discarded.body.data.status).toBe('void');
    expect((await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).status).toBe(201);
  });

  test('a sub-reseller has no ledger and no statement; a running period is refused', async () => {
    noSweep();
    const token = asStaff();
    const sub = await post('/resellers/3/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' });
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('NOT_TOP_LEVEL');
    const running = await post('/resellers/1/settlements', token, { period_start: '2026-11-01', period_end: '2026-11-30' });
    expect(running.status).toBe(422);
    expect(running.body.error.code).toBe('PERIOD_NOT_ENDED');
    expect(commissions.sweepCommissionGaps).not.toHaveBeenCalled();
  });

  test('a late reversal lands in the next statement; the approved one does not move', async () => {
    noSweep();
    seedLedger();
    const token = asStaff();
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    // On 5 November an October commission is reversed.
    line(1, 'commission_reversal', 40, at(OCT.endUtc, 4 * 24 * HOUR));
    const approved = await post(`/resellers/1/settlements/${oct.id}/approve`, token);
    expect(approved.status).toBe(200);
    expect(approved.body.recomputed).toBe(false);
    expect(approved.body.data).toMatchObject({ status: 'approved', closing_balance: oct.closing_balance });
    const novRes = await post('/resellers/1/settlements', token, { period_start: '2026-11-01', period_end: '2026-11-07' });
    expect(novRes.body.data.opening_balance).toBe(oct.closing_balance);
    expect(novRes.body.data.totals.commission_reversal).toBe(40);
    // Approved is frozen: no regenerate, discard or second approval.
    for (const action of ['regenerate', 'discard', 'approve']) {
      const r = await post(`/resellers/1/settlements/${oct.id}/${action}`, token);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('SETTLEMENT_NOT_DRAFT');
    }
  });

  test('approving recomputes and says so when a draft no longer matches its ledger', async () => {
    noSweep();
    seedLedger();
    const token = asStaff();
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    state.settlements[0].closing_balance = '1.00'; // a stale draft
    const res = await post(`/resellers/1/settlements/${oct.id}/approve`, token);
    expect(res.body.recomputed).toBe(true);
    expect(res.body.data.closing_balance).toBe(oct.closing_balance);
  });

  test('approving needs reseller_settlements.approve', async () => {
    noSweep();
    const token = asStaff();
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    const manager = asStaff(STAFF.filter((p) => p !== 'reseller_settlements.approve'));
    expect((await post(`/resellers/1/settlements/${oct.id}/approve`, manager)).status).toBe(403);
  });

  async function approvedOctober(token) {
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    return (await post(`/resellers/1/settlements/${oct.id}/approve`, token)).body.data;
  }

  test('the reseller owed the ISP: settling posts a deposit of the closing balance', async () => {
    noSweep();
    line(1, 'collection', 250, at(OCT.startUtc, HOUR));
    const token = asStaff();
    const oct = await approvedOctober(token);
    expect((await post(`/resellers/1/settlements/${oct.id}/settle`, token, {})).status).toBe(422); // bank_ref required
    const res = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'SPEI 123456' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'settled', bank_ref: 'SPEI 123456', settlement_entry_id: res.body.entry_id });
    const entry = state.ledger.find((e) => e.id === res.body.entry_id);
    expect(entry).toMatchObject({ entry_type: 'deposit', amount: '-250.00', created_by: USER });
    expect(entry.note).toMatch(/SPEI 123456/);
    expect(res.body.summary.balance).toBe(0);
    const again = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SETTLEMENT_NOT_APPROVED');
  });

  test('the ISP owed the reseller: settling posts a payout', async () => {
    noSweep();
    line(1, 'commission', -80, at(OCT.startUtc, HOUR));
    const token = asStaff();
    const oct = await approvedOctober(token);
    expect(oct.closing_balance).toBe(-80);
    const res = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'TR-9' });
    expect(state.ledger.find((e) => e.id === res.body.entry_id)).toMatchObject({ entry_type: 'payout', amount: '80.00' });
    expect(ledgerCents(state, 1)).toBe(0);
  });

  test('money that already moved is refused, and record_only settles without a line', async () => {
    noSweep();
    line(1, 'collection', 250, at(OCT.startUtc, HOUR));
    const token = asStaff();
    const oct = await approvedOctober(token);
    // In November the reseller sealed the cash in a bag.
    line(1, 'bag_sealed', -250, at(OCT.endUtc, 2 * 24 * HOUR));
    const refused = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'SPEI 1' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SETTLEMENT_EXCEEDS_BALANCE');
    expect(state.settlements[0].status).toBe('approved');
    const lines = state.ledger.length;
    const res = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'BOLSA B-1', record_only: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ entry_id: null, data: { status: 'settled', settlement_entry_id: null } });
    expect(state.ledger).toHaveLength(lines);
  });

  test('a zero closing settles without a line', async () => {
    noSweep();
    const token = asStaff();
    const oct = await approvedOctober(token);
    const res = await post(`/resellers/1/settlements/${oct.id}/settle`, token, { bank_ref: 'n/a' });
    expect(res.body).toMatchObject({ entry_id: null, data: { status: 'settled' } });
  });

  test('the statement shows its lines and prints a PDF', async () => {
    noSweep();
    seedLedger();
    const token = asStaff();
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    const res = await get(`/resellers/1/settlements/${oct.id}?limit=3`, token);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 8, limit: 3 });
    expect(res.body.lines.map((l) => l.entry_type)).toEqual(['collection', 'collection_void', 'bag_sealed']);
    const pdf = await get(`/resellers/1/settlements/${oct.id}/pdf`, token).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    const list = await get('/resellers/1/settlements', token);
    expect(list.body.meta).toMatchObject({ total: 1, default_period: { period_start: '2026-10-01', period_end: '2026-10-31' } });
  });

  test('a statement of another reseller is a 404', async () => {
    noSweep();
    const token = asStaff();
    const oct = (await post('/resellers/2/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    expect((await get(`/resellers/1/settlements/${oct.id}`, token)).status).toBe(404);
    expect((await post(`/resellers/1/settlements/${oct.id}/approve`, token)).status).toBe(404);
  });

  test('a reseller-bound user cannot use the staff routes, whatever its permissions', async () => {
    const token = asReseller(1, [...STAFF, 'reseller_app.use', 'reseller_app.statements']);
    expect((await get('/resellers/1/settlements', token)).status).toBe(403);
    expect((await post('/resellers/1/settlements', token, {})).status).toBe(403);
  });
});

describe('reseller app: its approved and settled statements', () => {
  async function seedStatements() {
    noSweep();
    const token = asStaff();
    const sep = (await post('/resellers/1/settlements', token, { period_start: '2026-09-01', period_end: '2026-09-30' })).body.data;
    await post(`/resellers/1/settlements/${sep.id}/approve`, token);
    const oct = (await post('/resellers/1/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    const other = (await post('/resellers/2/settlements', token, { period_start: '2026-10-01', period_end: '2026-10-31' })).body.data;
    await post(`/resellers/2/settlements/${other.id}/approve`, token);
    return { sep, oct, other };
  }

  test('lists only approved and settled statements of its own top-level reseller', async () => {
    const { sep, oct, other } = await seedStatements();
    const token = asReseller(1);
    const res = await get('/reseller-app/statements', token);
    expect(res.status).toBe(200);
    expect(res.body.data.map((x) => x.id)).toEqual([sep.id]);
    expect((await get(`/reseller-app/statements/${oct.id}`, token)).status).toBe(404); // a draft
    expect((await get(`/reseller-app/statements/${other.id}`, token)).status).toBe(404); // another reseller's
    expect((await get(`/reseller-app/statements/${other.id}/pdf`, token)).status).toBe(404);
    const one = await get(`/reseller-app/statements/${sep.id}`, token);
    expect(one.body.data).toMatchObject({ id: sep.id, status: 'approved' });
    expect(Array.isArray(one.body.lines)).toBe(true);
  });

  test('a sub-reseller login sees its parent\'s statements', async () => {
    const { sep } = await seedStatements();
    const res = await get('/reseller-app/statements', asReseller(3));
    expect(res.body.data.map((x) => x.id)).toEqual([sep.id]);
  });

  test('needs reseller_app.statements', async () => {
    const res = await get('/reseller-app/statements', asReseller(1, ['reseller_app.use']));
    expect(res.status).toBe(403);
  });
});

describe('commission gap sweep', () => {
  function seedCommissionCase() {
    state.commissionsSince = '2026-10-01 00:00:00';
    state.clients = {
      31: { id: 31, organization_id: ORG, reseller_id: 3 },   // sub-reseller client: earns on 1
      41: { id: 41, organization_id: ORG, reseller_id: null },
    };
    const paid = new Date('2026-10-10T12:00:00Z');
    state.invoices = {
      // paid, no commission: a missed sync
      901: { id: 901, organization_id: ORG, client_id: 31, invoice_number: 'F-901', status: 'paid', subtotal: '100.00', total: '116.00', currency: 'MXN', paid_at: paid, deleted_at: null },
      // paid before go-live: never earns
      902: { id: 902, organization_id: ORG, client_id: 31, invoice_number: 'F-902', status: 'paid', subtotal: '100.00', total: '116.00', currency: 'MXN', paid_at: new Date('2026-09-10T12:00:00Z'), deleted_at: null },
      // voided while its commission still stands: a failed best-effort reversal
      903: { id: 903, organization_id: ORG, client_id: 31, invoice_number: 'F-903', status: 'void', subtotal: '50.00', total: '58.00', currency: 'MXN', paid_at: paid, deleted_at: null },
      // a client without a reseller
      904: { id: 904, organization_id: ORG, client_id: 41, invoice_number: 'F-904', status: 'paid', subtotal: '100.00', total: '116.00', currency: 'MXN', paid_at: paid, deleted_at: null },
    };
    state.commissions = [{
      id: 1, organization_id: ORG, reseller_id: 1, invoice_id: 903, client_id: 31, commission_rate: '10.00', base_amount: '50.00',
      invoice_total: '58.00', commission_amount: '5.00', currency: 'MXN', status: 'earned', earned_at: paid, reversed_at: null, created_at: paid,
    }];
    state.seq.commission = 1;
  }

  test('books the missing commission and reverses the stale one, each once', async () => {
    seedCommissionCase();
    const first = await commissions.sweepCommissionGaps(ORG, 1);
    expect(first).toMatchObject({ earned: 1, reversed: 1, failed: 0, truncated: false });
    const earned = state.commissions.find((c) => c.invoice_id === 901);
    expect(earned).toMatchObject({ reseller_id: 1, commission_amount: '10.00', reversed_at: null });
    expect(state.commissions.find((c) => c.invoice_id === 903).reversed_at).not.toBeNull();
    expect(state.commissions.some((c) => c.invoice_id === 902 || c.invoice_id === 904)).toBe(false);
    expect(state.ledger.map((e) => [e.entry_type, e.amount, e.invoice_id])).toEqual([
      ['commission_reversal', '5.00', 903],
      ['commission', '-10.00', 901],
    ]);
    // Idempotent: a second sweep finds nothing to do.
    const second = await commissions.sweepCommissionGaps(ORG, 1);
    expect(second).toMatchObject({ earned: 0, reversed: 0, restored: 0 });
    expect(state.ledger).toHaveLength(2);
  });

  test('a sub-reseller id sweeps nothing of its own: commissions live on the top-level reseller', async () => {
    seedCommissionCase();
    const out = await commissions.sweepCommissionGaps(ORG, 3);
    // Its own client 31 is in its subtree: the missing commission is booked,
    // on the top-level reseller as always, and nothing is reversed for 3.
    expect(out.reversed).toBe(0);
    expect(state.commissions.find((c) => c.invoice_id === 901)?.reseller_id).toBe(1);
  });
});

describe('migration 008', () => {
  const file = path.join(__dirname, '..', 'database', 'migrations', '008_reseller_settlements.sql');
  const sql = fs.readFileSync(file, 'utf8');

  test('is the latest migration, with a rollback of the same name', () => {
    const files = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe('008_reseller_settlements.sql');
    expect(fs.existsSync(path.join(__dirname, '..', 'database', 'rollbacks', '008_reseller_settlements.sql'))).toBe(true);
  });

  test('is re-runnable and keeps the ledger lines a statement names', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS reseller_settlements/);
    expect(sql).not.toMatch(/^\s*ALTER TABLE/m);
    expect(sql).toMatch(/fk_reseller_settlements_entry FOREIGN KEY \(settlement_entry_id\)\s+REFERENCES reseller_ledger_entries \(id\) ON DELETE RESTRICT/);
    expect(sql).toMatch(/status\s+ENUM\('draft', 'approved', 'settled', 'void'\)/);
  });

  test('schema.sql carries the same table', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    const columns = (text) => [...text.slice(text.indexOf('CREATE TABLE IF NOT EXISTS reseller_settlements'))
      .split(') ENGINE=')[0].matchAll(/^\s+([a-z_]+)\s+(?:BIGINT|DATE|CHAR|DECIMAL|INT|ENUM|TIMESTAMP|VARCHAR)/gm)].map((m) => m[1]);
    expect(columns(schema)).toEqual(columns(sql));
    expect(columns(sql).length).toBeGreaterThan(25);
  });
});
