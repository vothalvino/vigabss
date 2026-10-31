// =============================================================================
// DB-04 — prepared-statement caches are bounded per connection
// =============================================================================
// db.query prepares every distinct SQL text (pool.execute). mysql2 cached up
// to 16,000 statements per connection and no pool set a cap, while MySQL
// allows max_prepared_stmt_count (16,382 by default) across all connections,
// so a busy install could exhaust it and every new statement then failed.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('mysql2/promise', () => ({
  createPool: jest.fn(() => ({ execute: jest.fn(), end: jest.fn(), getConnection: jest.fn(), on: jest.fn() })),
}));
jest.mock('../src/utils/dbMetrics', () => ({ recordDbQuery: jest.fn() }));

afterEach(() => {
  delete process.env.DB_REPLICA_HOST;
  delete process.env.DB_MAX_PREPARED_STATEMENTS;
});

function loadPools() {
  jest.resetModules();
  const mysql = require('mysql2/promise');
  require('../src/config/database');
  return mysql.createPool.mock.calls.map(([options]) => options);
}

test('the primary and replica pools cap prepared statements per connection', () => {
  process.env.DB_REPLICA_HOST = 'replica.internal';
  const pools = loadPools();
  expect(pools).toHaveLength(2);
  for (const options of pools) expect(options.maxPreparedStatements).toBe(128);
});

test('DB_MAX_PREPARED_STATEMENTS overrides the cap', () => {
  process.env.DB_MAX_PREPARED_STATEMENTS = '64';
  expect(loadPools()[0].maxPreparedStatements).toBe(64);
});

test('every pool database.js creates (tenant pools included) sets the cap', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'database.js'), 'utf8');
  const pools = source.split('mysql.createPool(').slice(1).map(rest => rest.slice(0, rest.indexOf('})')));
  // testTenantConnection's one-connection pool runs a single SELECT 1 and ends.
  const longLived = pools.filter(body => !/connectionLimit: 1,/.test(body));
  expect(longLived).toHaveLength(3);
  for (const body of longLived) expect(body).toContain('maxPreparedStatements: MAX_PREPARED_STATEMENTS');
});

test.each(['mysql/primary.cnf', 'mysql/replica.cnf'])('%s leaves room for every connection to fill its cache', (file) => {
  const cnf = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const connections = Number(/^max-connections\s*=\s*(\d+)/m.exec(cnf)[1]);
  const budget = Number(/^max-prepared-stmt-count\s*=\s*(\d+)/m.exec(cnf)?.[1] ?? 16382);
  expect(connections * 128).toBeLessThan(budget);
});
