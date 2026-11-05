'use strict';
// =============================================================================
// RADIUS accounting has its own database pool
// =============================================================================
// Accounting arrives in bursts (a NAS reboots and every session reports at
// once) and drew from the API's pool, so a burst queued staff requests behind
// it and a slow accounting statement could exhaust the API. Work inside
// db.withAccountingPool uses a separate pool; an isolated tenant's pool is
// still used for that tenant, and the accounting route runs inside the lane.
// =============================================================================

describe('the accounting pool', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.DB_REPLICA_HOST;
    delete process.env.DB_ACCOUNTING_POOL_SIZE;
  });

  function makePool() {
    const { EventEmitter } = require('events');
    return Object.assign(new EventEmitter(), {
      execute: jest.fn().mockResolvedValue([[], []]),
      getConnection: jest.fn().mockResolvedValue({ release: jest.fn() }),
      end: jest.fn().mockResolvedValue(undefined),
    });
  }

  function load(pools) {
    const createPool = jest.fn();
    for (const p of pools) createPool.mockReturnValueOnce(p);
    jest.doMock('mysql2/promise', () => ({ createPool }));
    const metrics = {
      recordDbQuery: jest.fn(), registerPoolStats: jest.fn(), recordPoolAcquire: jest.fn(), notePoolAcquireFailure: jest.fn(),
    };
    jest.doMock('../src/utils/dbMetrics', () => metrics);
    return { db: require('../src/config/database'), createPool, metrics };
  }

  test('serves queries inside the lane from its own pool, and the rest from the primary', async () => {
    const primary = makePool();
    const accounting = makePool();
    const { db, createPool } = load([primary, accounting]);

    await db.query('SELECT 1', []);
    await db.withAccountingPool(() => db.query('INSERT INTO radius_accounting_events VALUES ()', []));

    expect(primary.execute).toHaveBeenCalledWith('SELECT 1', []);
    expect(accounting.execute).toHaveBeenCalledWith('INSERT INTO radius_accounting_events VALUES ()', []);
    expect(primary.execute).not.toHaveBeenCalledWith('INSERT INTO radius_accounting_events VALUES ()', []);
    expect(createPool).toHaveBeenCalledTimes(2);
  });

  test('is sized by DB_ACCOUNTING_POOL_SIZE (default 5) and created only when used', async () => {
    process.env.DB_ACCOUNTING_POOL_SIZE = '7';
    const { db, createPool } = load([makePool(), makePool()]);
    expect(createPool).toHaveBeenCalledTimes(1);

    await db.withAccountingPool(() => db.query('SELECT 1', []));

    expect(createPool).toHaveBeenCalledTimes(2);
    expect(createPool.mock.calls[1][0]).toMatchObject({ connectionLimit: 7, waitForConnections: true });
  });

  test('lends transaction connections from its own pool too', async () => {
    const primary = makePool();
    const accounting = makePool();
    const { db } = load([primary, accounting]);

    await db.withAccountingPool(() => db.getConnection());

    expect(accounting.getConnection).toHaveBeenCalled();
    expect(primary.getConnection).not.toHaveBeenCalled();
  });

  test('still uses an isolated tenant\'s own pool inside the lane', async () => {
    const primary = makePool();
    const tenant = makePool();
    primary.execute.mockResolvedValueOnce([[{
      organization_id: 5, isolation_mode: 'isolated', db_host: 'tenant-db', db_port: 3306,
      db_name: 'fireisp_org_5', db_user: 'tenant_user', db_password_encrypted: 'secret', ssl_enabled: 0,
    }], []]);
    const { db } = load([primary, tenant]);

    await db.withAccountingPool(() => db.withTenantContext(5, () => db.query('SELECT * FROM radius', [])));

    expect(tenant.execute).toHaveBeenCalledWith('SELECT * FROM radius', []);
  });

  test('reports its connections as the "accounting" pool', async () => {
    const { db, metrics } = load([makePool(), makePool()]);
    await db.withAccountingPool(() => db.getConnection());
    expect(metrics.recordPoolAcquire).toHaveBeenCalledWith('accounting', expect.any(Number));
  });
});

// The route that runs inside the lane is covered in
// tests/radiusTenantAccounting.test.js.
