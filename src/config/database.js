// =============================================================================
// VigaBSS 5.0 — Database Connection Pool
// =============================================================================
// Creates and exports a mysql2/promise connection pool configured from
// environment variables. All application code should import `db` from here.
// =============================================================================

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const {
  recordDbQuery, registerPoolStats, recordPoolAcquire, notePoolAcquireFailure,
} = require('../utils/dbMetrics');
const { AppError } = require('../utils/errors');
const { decrypt } = require('../utils/encryption');

const parseIntEnv = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

const parseBoolEnv = (key, fallback) => {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

/**
 * Shared connection parameters derived from environment variables.
 * Used by both the main application pool and the migration runner.
 */
const baseConnectionConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'fireisp',
  charset: 'utf8mb4',
  timezone: '+00:00',
};

// db.query runs pool.execute, which prepares every distinct SQL text on the
// server. mysql2 caches those statements per connection (LRU of 16,000 by
// default) and never closes them while the connection lives, and the server
// allows max_prepared_stmt_count (16,382 by default) across ALL connections,
// so a busy install with pooled connections from several replicas could
// exhaust it and every new statement then failed (DB-04). Each connection
// now keeps at most DB_MAX_PREPARED_STATEMENTS; keep
// connections x this cap below the server's max_prepared_stmt_count.
const MAX_PREPARED_STATEMENTS = Math.max(1, parseIntEnv('DB_MAX_PREPARED_STATEMENTS', 128));

// mysql2's `timezone` only converts JS Dates on the client; NOW(),
// CURRENT_TIMESTAMP and TIMESTAMP columns use the server session's time_zone.
// The bundled MySQL defaults to UTC, but an external server may not, so every
// pooled connection pins its session to UTC (DB-27).
function pinSessionToUtc(targetPool) {
  if (!targetPool || typeof targetPool.on !== 'function') return targetPool;
  // The promise pool re-emits the core pool's event with the core
  // (callback-style) connection. Commands queue in order, so the SET runs
  // before any statement from the caller that receives this connection.
  targetPool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'", (err) => {
      if (!err) return;
      // A connection that cannot be pinned would mix time zones: drop it.
      require('../utils/logger').error({ err }, 'Could not set the MySQL session time_zone to UTC; closing the connection');
      if (typeof conn.destroy === 'function') conn.destroy();
    });
  });
  return targetPool;
}

// A finite queue: with 0 (unbounded) a saturated pool made every request wait
// until its 30 s timeout. A full queue fails at once with a 503 (DB-25).
const DEFAULT_QUEUE_LIMIT = 200;

const pool = pinSessionToUtc(mysql.createPool({
  ...baseConnectionConfig,
  maxPreparedStatements: MAX_PREPARED_STATEMENTS,
  waitForConnections: true,
  connectionLimit: parseIntEnv('DB_POOL_SIZE', 20),
  queueLimit: parseIntEnv('DB_QUEUE_LIMIT', DEFAULT_QUEUE_LIMIT),
  enableKeepAlive: true,
  keepAliveInitialDelay: parseIntEnv('DB_KEEP_ALIVE_MS', 30000),
}));

const tenantContext = new AsyncLocalStorage();
// An invalidation may race an already-running primary lookup. A generation is
// captured before each lookup/pool creation and checked again before anything
// is cached, so an old result can never repopulate routing state after an
// operator switches the organization back to shared or rotates its database.
const tenantConfigGenerations = new Map();
// tenantPoolCache: key -> { pool, lastUsed }. Entries are evicted on an idle TTL
// and capped with LRU eviction so multi-tenant deployments with many orgs do not
// accumulate connection pools indefinitely.
const tenantPoolCache = new Map();
// Close a tenant pool after it has been idle for this long (0 disables idle eviction).
const TENANT_POOL_IDLE_MS = parseIntEnv('TENANT_DB_POOL_IDLE_MS', 300000);
// Maximum number of tenant pools to keep cached before LRU-evicting the oldest.
const TENANT_POOL_MAX = Math.max(1, parseIntEnv('TENANT_DB_POOL_MAX', 100));

/**
 * Read replica pool — created only when DB_REPLICA_HOST is set.
 * Falls back to the primary pool when no replica is configured so that
 * `queryReplica` works transparently in single-server deployments.
 */
const replicaPool = process.env.DB_REPLICA_HOST
  ? pinSessionToUtc(mysql.createPool({
    host: process.env.DB_REPLICA_HOST,
    port: parseInt(process.env.DB_REPLICA_PORT || '3306', 10),
    user: process.env.DB_REPLICA_USER || process.env.DB_USER || 'root',
    password: process.env.DB_REPLICA_PASSWORD !== undefined
      ? process.env.DB_REPLICA_PASSWORD
      : (process.env.DB_PASSWORD || ''),
    database: process.env.DB_NAME || 'fireisp',
    charset: 'utf8mb4',
    timezone: '+00:00',
    waitForConnections: true,
    connectionLimit: parseIntEnv('DB_REPLICA_POOL_SIZE', 10),
    maxPreparedStatements: MAX_PREPARED_STATEMENTS,
    queueLimit: parseIntEnv('DB_QUEUE_LIMIT', DEFAULT_QUEUE_LIMIT),
    enableKeepAlive: true,
    keepAliveInitialDelay: parseIntEnv('DB_KEEP_ALIVE_MS', 30000),
  }))

  : null;

// RADIUS accounting arrives in bursts (a NAS reboots and every session sends
// Start or Interim at once) and used to draw from `pool`, so a burst queued
// staff requests behind it and one slow accounting statement could exhaust
// the API. Work inside withAccountingPool uses its own pool, sized by
// DB_ACCOUNTING_POOL_SIZE: a burst waits for accounting connections only.
// Only the primary pool is swapped; an isolated tenant's pool is still used.
const poolLane = new AsyncLocalStorage();
let accountingPool = null;

function getAccountingPool() {
  if (!accountingPool) {
    accountingPool = pinSessionToUtc(mysql.createPool({
      ...baseConnectionConfig,
      maxPreparedStatements: MAX_PREPARED_STATEMENTS,
      waitForConnections: true,
      connectionLimit: parseIntEnv('DB_ACCOUNTING_POOL_SIZE', 5),
      queueLimit: parseIntEnv('DB_QUEUE_LIMIT', DEFAULT_QUEUE_LIMIT),
      enableKeepAlive: true,
      keepAliveInitialDelay: parseIntEnv('DB_KEEP_ALIVE_MS', 30000),
    }));
  }
  return accountingPool;
}

/** Run `callback` with primary-database work on the accounting pool. */
function withAccountingPool(callback) {
  return poolLane.run({ lane: 'accounting' }, callback);
}

function withTenantContext(orgId, callback) {
  return tenantContext.run({ orgId }, callback);
}

/**
 * Run install-wide work against the primary database even when the caller is
 * currently inside an isolated tenant's AsyncLocalStorage context.
 *
 * This is intentionally explicit: passing `organizationId = null` to a service
 * does not change database routing by itself. Without resetting the context, a
 * host-wide manual task mixes tenant-DB queries with host/file side effects.
 */
function withPrimaryContext(callback) {
  return tenantContext.run({ orgId: null }, callback);
}

function normalizeTenantConfig(row) {
  if (!row || row.isolation_mode !== 'isolated') return null;
  if (!row.db_host || !row.db_name || !row.db_user) {
    throw new Error(`Tenant ${row.organization_id} has incomplete isolated database configuration`);
  }
  return {
    host: row.db_host,
    port: row.db_port || 3306,
    user: row.db_user,
    password: decrypt(row.db_password_encrypted) || '',
    database: row.db_name,
    ssl: row.ssl_enabled
      ? { rejectUnauthorized: parseBoolEnv('TENANT_DB_SSL_REJECT_UNAUTHORIZED', true) }
      : undefined,
  };
}

function tenantConfigFingerprint(row) {
  if (!row || row.isolation_mode !== 'isolated') return 'shared';
  return crypto.createHash('sha256').update(JSON.stringify([
    row.organization_id,
    row.isolation_mode,
    row.db_host,
    Number(row.db_port || 3306),
    row.db_name,
    row.db_user,
    row.db_password_encrypted || null,
    Boolean(row.ssl_enabled),
  ])).digest('hex');
}

function tenantConfigGeneration(key) {
  return tenantConfigGenerations.get(key) || 0;
}

// One registry read per tenant context (one request or job) rather than per
// statement (DB-22). The memo lives in the AsyncLocalStorage store, is dropped
// when this process invalidates the org (generation bump), and expires after
// a few seconds so a long scheduler job still sees another replica's change.
const TENANT_SNAPSHOT_MAX_AGE_MS = parseIntEnv('TENANT_DB_SNAPSHOT_MAX_AGE_MS', 5000);

function memoizedSnapshot(key) {
  const store = tenantContext.getStore();
  const memo = store?.tenantSnapshot;
  if (!memo || memo.key !== key) return null;
  if (memo.generation !== tenantConfigGeneration(key)) return null;
  if (Date.now() - memo.at > TENANT_SNAPSHOT_MAX_AGE_MS) return null;
  return memo.snapshot;
}

function rememberSnapshot(key, snapshot) {
  const store = tenantContext.getStore();
  if (store && String(store.orgId) === key) {
    store.tenantSnapshot = { key, generation: snapshot.generation, at: Date.now(), snapshot };
  }
}

async function getTenantConnectionConfigSnapshot(orgId) {
  if (!orgId) return null;
  const key = String(orgId);
  const memo = memoizedSnapshot(key);
  if (memo) return memo;
  for (let attempt = 0; attempt < 3; attempt++) {
    const generation = tenantConfigGeneration(key);
    const [rows] = await pool.execute(
      `SELECT organization_id, isolation_mode, db_host, db_port, db_name, db_user,
              db_password_encrypted, ssl_enabled
         FROM organization_database_configs
        WHERE organization_id = ?`,
      [orgId],
    );
    const row = rows[0] || null;
    const value = normalizeTenantConfig(row);
    if (tenantConfigGeneration(key) !== generation) continue;
    // No cross-request cache: every routed request (or job) rechecks the
    // authoritative primary registry once, so a change made by another replica
    // is visible before this process can reuse a tenant pool.
    const snapshot = { value, generation, fingerprint: tenantConfigFingerprint(row) };
    rememberSnapshot(key, snapshot);
    return snapshot;
  }
  const err = new Error('Tenant database configuration changed during resolution');
  err.code = 'TENANT_DB_CONFIG_CHANGED';
  throw err;
}

async function getTenantConnectionConfig(orgId) {
  return (await getTenantConnectionConfigSnapshot(orgId))?.value || null;
}

/**
 * Count a pool's checked-out connections (DB-11). pool.end() closes every
 * connection, borrowed ones included, so the next command on a connection a
 * transaction or job was still holding failed with "Can't add new command
 * when connection is in closed state". A retired pool is ended only once its
 * last borrowed connection comes back.
 */
function trackBorrows(entry) {
  entry.borrowed = 0;
  entry.retired = false;
  entry.pool.on('acquire', () => {
    entry.borrowed += 1;
    entry.lastUsed = Date.now();
  });
  entry.pool.on('release', () => {
    entry.borrowed = Math.max(0, entry.borrowed - 1);
    entry.lastUsed = Date.now();
    if (entry.retired && entry.borrowed === 0) endTenantPool(entry);
  });
  return entry;
}

function endTenantPool(entry) {
  if (entry.ended) return entry.ending;
  entry.ended = true;
  entry.ending = Promise.resolve().then(() => entry.pool.end()).catch(() => {});
  return entry.ending;
}

/**
 * Close and remove a single tenant pool from the cache. A pool with
 * connections still checked out is retired and ends when they return.
 * Pool shutdown errors are swallowed so eviction never rejects the caller.
 */
function evictTenantPool(key, entry) {
  if (tenantPoolCache.get(key) === entry) tenantPoolCache.delete(key);
  if (entry.borrowed > 0) {
    entry.retired = true;
    return Promise.resolve();
  }
  return endTenantPool(entry);
}

/**
 * Close any tenant pools that have been idle longer than TENANT_POOL_IDLE_MS.
 * A pool with a borrowed connection is in use, however old its last query.
 */
function evictIdleTenantPools(now = Date.now()) {
  if (TENANT_POOL_IDLE_MS <= 0) return;
  for (const [key, entry] of tenantPoolCache) {
    if (entry.borrowed > 0) continue;
    if (now - entry.lastUsed > TENANT_POOL_IDLE_MS) evictTenantPool(key, entry);
  }
}

async function getTenantPool(orgId) {
  const snapshot = await getTenantConnectionConfigSnapshot(orgId);
  const config = snapshot?.value;
  const key = String(orgId);
  if (!config) {
    const stale = tenantPoolCache.get(key);
    if (stale) evictTenantPool(key, stale);
    return null;
  }
  if (tenantConfigGeneration(key) !== snapshot.generation) {
    return getTenantPool(orgId);
  }
  const now = Date.now();
  evictIdleTenantPools(now);

  let entry = tenantPoolCache.get(key);
  if (entry
      && entry.generation === snapshot.generation
      && entry.fingerprint === snapshot.fingerprint) {
    // Refresh LRU recency by re-inserting at the end of the Map.
    tenantPoolCache.delete(key);
  } else {
    if (entry) evictTenantPool(key, entry);
    entry = trackBorrows({
      pool: pinSessionToUtc(mysql.createPool({
        ...config,
        charset: 'utf8mb4',
        timezone: '+00:00',
        waitForConnections: true,
        connectionLimit: parseIntEnv('TENANT_DB_POOL_SIZE', 10),
        maxPreparedStatements: MAX_PREPARED_STATEMENTS,
        queueLimit: parseIntEnv('DB_QUEUE_LIMIT', DEFAULT_QUEUE_LIMIT),
        enableKeepAlive: true,
        keepAliveInitialDelay: parseIntEnv('DB_KEEP_ALIVE_MS', 30000),
      })),

      generation: snapshot.generation,
      fingerprint: snapshot.fingerprint,
      lastUsed: now,
    });
  }
  entry.lastUsed = now;
  tenantPoolCache.set(key, entry);

  // Enforce the LRU cap by evicting the least-recently-used pools.
  while (tenantPoolCache.size > TENANT_POOL_MAX) {
    const oldestKey = tenantPoolCache.keys().next().value;
    if (oldestKey === key) break;
    evictTenantPool(oldestKey, tenantPoolCache.get(oldestKey));
  }

  return entry.pool;
}

async function getCurrentPool({ preferReplica = false } = {}) {
  const store = tenantContext.getStore();
  if (store?.orgId) {
    const tenantPool = await getTenantPool(store.orgId);
    if (tenantPool) return tenantPool;
  }
  if (preferReplica) return replicaPool || pool;
  return poolLane.getStore()?.lane === 'accounting' ? getAccountingPool() : pool;
}

async function invalidateTenantDbConfig(orgId) {
  const key = String(orgId);
  tenantConfigGenerations.set(key, tenantConfigGeneration(key) + 1);
  const entry = tenantPoolCache.get(key);
  if (entry) await evictTenantPool(key, entry);
}

async function testTenantConnection(connectionConfig) {
  const testPool = mysql.createPool({
    ...baseConnectionConfig,
    ...connectionConfig,
    password: connectionConfig.password || '',
    charset: 'utf8mb4',
    timezone: '+00:00',
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 0,
  });
  try {
    await testPool.execute('SELECT 1');
    return true;
  } finally {
    await testPool.end();
  }
}

/**
 * Run a query and return [rows, fields].
 * Records DB query duration into the Prometheus histogram.
 */
async function query(sql, params) {
  const targetPool = await getCurrentPool();
  const start = process.hrtime.bigint();
  try {
    return await executeOn(targetPool, sql, params);
  } finally {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const op = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)/i.exec(sql);
    recordDbQuery(durationSeconds, op ? op[1].toUpperCase() : 'OTHER');
  }
}

// How long a request may wait for a connection before it fails with a 503
// instead of hanging until the request timeout (DB-25). The lock pool has no
// limit: a scheduled task waiting for a lock session holds nothing.
const ACQUIRE_TIMEOUT_MS = parseIntEnv('DB_ACQUIRE_TIMEOUT_MS', 10000);

function poolExhausted(poolName, reason) {
  notePoolAcquireFailure(poolName, reason);
  return new AppError('The database is busy; try again shortly', 503, 'DB_POOL_EXHAUSTED');
}

function poolName(targetPool) {
  if (targetPool === pool) return 'primary';
  if (targetPool === replicaPool) return 'replica';
  if (targetPool && targetPool === accountingPool) return 'accounting';
  return 'tenant';
}

/**
 * Borrow a connection, waiting at most DB_ACQUIRE_TIMEOUT_MS. A connection
 * that arrives after the caller gave up goes straight back to the pool, so a
 * request that already failed never runs its query later.
 */
function acquireConnection(targetPool) {
  const name = poolName(targetPool);
  const start = process.hrtime.bigint();
  const pending = targetPool.getConnection().catch((err) => {
    throw /Queue limit reached/.test(err?.message) ? poolExhausted(name, 'queue_full') : err;
  });
  const record = (conn) => {
    recordPoolAcquire(name, Number(process.hrtime.bigint() - start) / 1e9);
    return conn;
  };
  if (!(ACQUIRE_TIMEOUT_MS > 0)) return pending.then(record);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(poolExhausted(name, 'timeout'));
    }, ACQUIRE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    pending.then((conn) => {
      if (settled) {
        conn.release();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(record(conn));
    }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// True when a new request would have to wait for a connection.
function saturated(targetPool) {
  const core = targetPool?.pool;
  if (!core?._allConnections) return false;
  return core._freeConnections.length === 0 && core._allConnections.length >= core.config.connectionLimit;
}

// pool.execute queues without a limit on the wait, and a queued statement
// cannot be withdrawn. When the pool is full, borrow a connection with the
// bounded wait instead and run the statement on it.
async function executeOn(targetPool, sql, params) {
  if (!saturated(targetPool)) return targetPool.execute(sql, params);
  const conn = await acquireConnection(targetPool);
  try {
    return await conn.execute(sql, params);
  } finally {
    conn.release();
  }
}

/**
 * Run a read-only SELECT query against the replica pool.
 * Falls back to the primary pool when no replica is configured.
 * Use this for all report and dashboard queries.
 */
async function queryReplica(sql, params) {
  const targetPool = await getCurrentPool({ preferReplica: true });
  const start = process.hrtime.bigint();
  try {
    return await executeOn(targetPool, sql, params);
  } finally {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    recordDbQuery(durationSeconds, 'SELECT');
  }
}

/**
 * Get a single connection from the replica-preferred pool (falls back like
 * queryReplica). For report work that must set session state and run its
 * query on the SAME connection, then reset it before release (DAL-11).
 */
async function getReplicaConnection() {
  const targetPool = await getCurrentPool({ preferReplica: true });
  return acquireConnection(targetPool);
}

/**
 * Get a single connection from the pool (for transactions).
 */
async function getConnection() {
  const targetPool = await getCurrentPool();
  return acquireConnection(targetPool);
}

// Advisory locks (GET_LOCK) stay on one session for as long as the work they
// guard runs, and that work queries through `pool`. Holding the lock sessions
// in `pool` deadlocked the whole API: 20 scheduled tasks due at one 5-minute
// mark took all 20 connections for their locks, then each waited forever for
// a 21st. Lock sessions come from this separate pool instead. Its size caps
// how many guarded runs go at once; a run waiting here holds nothing.
let lockPool = null;

function getLockConnection() {
  if (!lockPool) {
    lockPool = pinSessionToUtc(mysql.createPool({
      ...baseConnectionConfig,
      maxPreparedStatements: MAX_PREPARED_STATEMENTS,
      waitForConnections: true,
      connectionLimit: parseIntEnv('DB_LOCK_POOL_SIZE', 8),
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: parseIntEnv('DB_KEEP_ALIVE_MS', 30000),
    }));
  }
  return lockPool.getConnection();
}

// mysql2 keeps the counts on the callback pool behind the promise wrapper.
function readPool(name, targetPool) {
  const core = targetPool?.pool;
  if (!core?._allConnections) return null;
  const all = core._allConnections.length;
  const idle = core._freeConnections.length;
  return { pool: name, inUse: all - idle, idle, limit: core.config.connectionLimit, waiting: core._connectionQueue.length };
}

registerPoolStats(() => {
  const stats = [readPool('primary', pool), readPool('replica', replicaPool), readPool('lock', lockPool), readPool('accounting', accountingPool)];
  const tenants = [...tenantPoolCache.values()].map(entry => readPool('tenant', entry.pool)).filter(Boolean);
  if (tenants.length) {
    stats.push(tenants.reduce((sum, t) => ({
      pool: 'tenant', inUse: sum.inUse + t.inUse, idle: sum.idle + t.idle, limit: sum.limit + t.limit, waiting: sum.waiting + t.waiting,
    })));
  }
  return stats.filter(Boolean);
});

/**
 * Close the pool (for graceful shutdown).
 */
async function close() {
  const tasks = [pool.end()];
  if (replicaPool) tasks.push(replicaPool.end());
  if (lockPool) tasks.push(lockPool.end());
  lockPool = null;
  if (accountingPool) tasks.push(accountingPool.end());
  accountingPool = null;
  for (const entry of tenantPoolCache.values()) tasks.push(entry.pool.end());
  tenantPoolCache.clear();
  tenantConfigGenerations.clear();
  // Use allSettled so that a single pool failing to close does not prevent the
  // remaining pools from being drained during graceful shutdown.
  await Promise.allSettled(tasks);
}

module.exports = {
  pool,
  replicaPool,
  query,
  queryReplica,
  getConnection,
  getLockConnection,
  getReplicaConnection,
  close,
  baseConnectionConfig,
  withTenantContext,
  withPrimaryContext,
  withAccountingPool,
  getTenantConnectionConfig,
  invalidateTenantDbConfig,
  testTenantConnection,
};
