// =============================================================================
// ASY-38 — audit log integrity and visibility
// =============================================================================
// There was no hash chain, so a database administrator could change audit
// rows without a trace, and install-wide events (organization_id NULL) matched
// no organization's filter, so nobody could read them.
// =============================================================================

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withPrimaryContext: (fn) => fn(),
}));
jest.mock('../src/utils/primaryContext', () => ({ runInPrimaryContext: (fn) => fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 4, email: 'op@test' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 12; next(); } }));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));
const mockOperator = { value: false };
jest.mock('../src/services/installOperator', () => ({
  isInstallOperator: async () => mockOperator.value,
  OPERATOR_ONLY_MESSAGE: 'Install operator only',
}));

const db = require('../src/config/database');
const { verifyAuditChain, GENESIS } = require('../src/services/auditChainService');

const app = express();
app.use('/audit-logs', require('../src/routes/auditLogs'));

const h = (n) => String(n).repeat(64).slice(0, 64);

beforeEach(() => {
  jest.clearAllMocks();
  mockOperator.value = false;
});

describe('install-wide events', () => {
  test('the install operator lists events with no organization', async () => {
    mockOperator.value = true;
    db.query.mockResolvedValueOnce([[{ id: 1, organization_id: null, action: 'backup_download' }]])
      .mockResolvedValueOnce([[{ total: 1 }]]);

    const res = await request(app).get('/audit-logs?scope=install');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE organization_id IS NULL ORDER BY/);
    expect(params).toEqual([]);
  });

  test('anyone else is refused, and the default stays the caller\'s organization', async () => {
    const refused = await request(app).get('/audit-logs?scope=install');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
    expect(db.query).not.toHaveBeenCalled();

    db.query.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ total: 0 }]]);
    await request(app).get('/audit-logs');
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE organization_id = \?/);
    expect(db.query.mock.calls[0][1]).toEqual([12]);
  });

  test('an unknown scope is rejected', async () => {
    const res = await request(app).get('/audit-logs?scope=everything');
    expect(res.status).toBe(422);
  });
});

describe('hash chain verification', () => {
  function chain(rows, head) {
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM audit_logs\s+WHERE organization_id <=> \? AND chain_seq > \?/.test(sql)) {
        return [rows.filter(r => r.chain_seq > params[1])];
      }
      if (/FROM audit_log_chain/.test(sql)) return [[head].filter(Boolean)];
      if (/chain_seq IS NULL/.test(sql)) return [[{ total: 0 }]];
      throw new Error(`unexpected SQL ${sql}`);
    });
  }
  const row = (id, seq, prev, hash, expected = hash) => (
    { id, chain_seq: seq, prev_hash: prev, row_hash: hash, expected_hash: expected });

  test('an untouched chain is intact', async () => {
    chain([row(1, 1, GENESIS, h(1)), row(2, 2, h(1), h(2))], { last_seq: 2, last_hash: h(2) });

    await expect(verifyAuditChain(12)).resolves.toEqual({
      intact: true, checked: 2, last_seq: 2, unchained: 0, problems: [],
    });
    expect(db.query.mock.calls[0][1]).toEqual([12, 0]);
    expect(db.query.mock.calls[0][0]).toMatch(/audit_log_row_hash\(prev_hash, chain_seq, organization_id/);
  });

  test('a changed row, a removed row and a cut-off tail are each reported', async () => {
    chain([
      row(1, 1, GENESIS, h(1), h(9)), // content changed after it was written
      row(3, 3, h(2), h(3)), // row 2 removed
    ], { last_seq: 4, last_hash: h(4) }); // row 4 removed from the end

    const result = await verifyAuditChain(12);

    expect(result.intact).toBe(false);
    expect(result.problems).toEqual([
      { id: 1, chain_seq: 1, problem: 'row content does not match its hash' },
      { id: 3, chain_seq: 3, problem: 'missing rows 2–2' },
      { id: 3, chain_seq: 3, problem: 'prev_hash does not match the previous row' },
      { id: null, chain_seq: 4, problem: 'chain head is at 4 but the newest row is at 3' },
    ]);
  });

  test('the install-wide chain is chain key 0', async () => {
    chain([row(5, 1, GENESIS, h(1))], { last_seq: 1, last_hash: h(1) });

    await verifyAuditChain(null);

    expect(db.query.mock.calls[0][1]).toEqual([null, 0]);
    expect(db.query.mock.calls[1][1]).toEqual([0]);
  });

  test('GET /audit-logs/verify checks the caller\'s organization, or the install chain for the operator', async () => {
    chain([], null);

    const own = await request(app).get('/audit-logs/verify');
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ intact: true, checked: 0 });
    expect(db.query.mock.calls[0][1]).toEqual([12, 0]);

    db.query.mockClear();
    expect((await request(app).get('/audit-logs/verify?scope=install')).status).toBe(403);
    mockOperator.value = true;
    await request(app).get('/audit-logs/verify?scope=install');
    expect(db.query.mock.calls[0][1]).toEqual([null, 0]);
  });
});
