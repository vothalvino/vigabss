// =============================================================================
// DAL-11 — the custom-report time cap is set, used and reset on one connection
// =============================================================================

const express = require('express');
const request = require('supertest');

const mockConn = { query: jest.fn(), release: jest.fn(), destroy: jest.fn() };
jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => [{ affectedRows: 1 }]),
  queryReplica: jest.fn(async () => [[{ id: 3, name: 'R', query_type: 'sql', sql_query: 'SELECT id FROM clients' }]]),
  getReplicaConnection: jest.fn(async () => mockConn),
}));
jest.mock('../src/middleware/auth', () => ({ authenticate: (req, _res, next) => { req.user = { id: 1 }; next(); } }));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));
jest.mock('../src/services/installOperator', () => ({ isInstallOperator: async () => true, OPERATOR_ONLY_MESSAGE: 'x' }));

const db = require('../src/config/database');
const app = express();
app.use(express.json());
app.use('/custom-reports', require('../src/routes/customReports'));

beforeEach(() => {
  jest.clearAllMocks();
  mockConn.query.mockImplementation(async (sql) => (/^SET/.test(sql) ? [{}] : [[{ id: 1 }]]));
});

test('SET, the report and the reset all run on the same connection, which is then released', async () => {
  const res = await request(app).post('/custom-reports/3/execute');
  expect(res.status).toBe(200);
  const sqls = mockConn.query.mock.calls.map(([sql]) => sql);
  expect(sqls[0]).toBe('SET SESSION max_execution_time = 30000');
  expect(sqls[1]).toMatch(/^SELECT id FROM clients/);
  expect(sqls[2]).toBe('SET SESSION max_execution_time = DEFAULT');
  expect(mockConn.release).toHaveBeenCalledTimes(1);
  // Nothing session-scoped goes through the shared pool any more.
  expect(db.queryReplica.mock.calls.some(([sql]) => /SET SESSION/.test(sql))).toBe(false);
});

test('a connection whose cap cannot be reset is destroyed, not returned to the pool', async () => {
  mockConn.query.mockImplementation(async (sql) => {
    if (/= DEFAULT/.test(sql)) throw new Error('gone');
    return /^SET/.test(sql) ? [{}] : [[{ id: 1 }]];
  });
  await request(app).post('/custom-reports/3/execute');
  expect(mockConn.destroy).toHaveBeenCalledTimes(1);
  expect(mockConn.release).not.toHaveBeenCalled();
});
