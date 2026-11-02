'use strict';
// =============================================================================
// DB-25 — a saturated pool fails fast with a 503, and the pools are measured
// =============================================================================
// The primary pool queued without limit and mysql2 has no acquire timeout, so
// when every connection was busy each request waited until its 30 s request
// timeout, and nothing showed how full any pool was.
// =============================================================================

// A pool whose connections are all checked out.
function fullPool() {
  const core = {
    _allConnections: { length: 2 },
    _freeConnections: { length: 0 },
    _connectionQueue: { length: 3 },
    config: { connectionLimit: 2 },
  };
  return { pool: core, execute: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() };
}

function load(pool, env = {}) {
  jest.resetModules();
  Object.assign(process.env, env);
  const createPool = jest.fn(() => pool);
  jest.doMock('mysql2/promise', () => ({ createPool }));
  return { db: require('../src/config/database'), createPool, metrics: require('../src/utils/metricsRegistry').registry };
}

afterEach(() => {
  delete process.env.DB_ACQUIRE_TIMEOUT_MS;
  delete process.env.DB_QUEUE_LIMIT;
  jest.dontMock('mysql2/promise');
});

test('the queue is finite by default', () => {
  const { createPool } = load(fullPool());
  expect(createPool.mock.calls[0][0].queueLimit).toBe(200);
});

test('a query that cannot get a connection in time fails with a 503 and never runs later', async () => {
  const pool = fullPool();
  let handOver;
  pool.getConnection.mockReturnValue(new Promise((resolve) => { handOver = resolve; }));
  const { db, metrics } = load(pool, { DB_ACQUIRE_TIMEOUT_MS: '50' });

  await expect(db.query('UPDATE invoices SET status = ? WHERE id = ?', ['paid', 1]))
    .rejects.toMatchObject({ statusCode: 503, code: 'DB_POOL_EXHAUSTED' });
  expect(pool.execute).not.toHaveBeenCalled();

  // The connection frees up after the caller gave up: it goes straight back.
  const late = { execute: jest.fn(), release: jest.fn() };
  handOver(late);
  await new Promise(resolve => setImmediate(resolve));
  expect(late.release).toHaveBeenCalledTimes(1);
  expect(late.execute).not.toHaveBeenCalled();
  expect(metrics.render()).toMatch(/^db_pool_acquire_failures_total\{pool="primary",reason="timeout"\} 1$/m);
});

test('a full queue fails at once with a 503', async () => {
  const pool = fullPool();
  pool.getConnection.mockRejectedValue(new Error('Queue limit reached.'));
  const { db } = load(pool);

  await expect(db.getConnection()).rejects.toMatchObject({ statusCode: 503, code: 'DB_POOL_EXHAUSTED' });
});

test('a connection that arrives in time runs the statement and is released', async () => {
  const pool = fullPool();
  const conn = { execute: jest.fn().mockResolvedValue([[{ ok: 1 }]]), release: jest.fn() };
  pool.getConnection.mockResolvedValue(conn);
  const { db } = load(pool, { DB_ACQUIRE_TIMEOUT_MS: '1000' });

  await expect(db.query('SELECT 1', [])).resolves.toEqual([[{ ok: 1 }]]);
  expect(conn.release).toHaveBeenCalledTimes(1);
});

test('pool usage is exported', () => {
  const { metrics } = load(fullPool());
  const out = metrics.render();
  expect(out).toMatch(/^db_pool_connections\{pool="primary",state="in_use"\} 2$/m);
  expect(out).toMatch(/^db_pool_connections\{pool="primary",state="idle"\} 0$/m);
  expect(out).toMatch(/^db_pool_waiting_requests\{pool="primary"\} 3$/m);
  expect(out).toMatch(/^db_pool_connection_limit\{pool="primary"\} 2$/m);
});
