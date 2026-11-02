// =============================================================================
// VigaBSS 5.0 — DB Query Metrics Recorder
// =============================================================================
// Standalone module that records the db_query_duration_seconds histogram.
// Imported by both src/config/database.js (to record) and src/routes/metrics.js
// (to expose via /metrics). Keeping this separate avoids a routes→config
// circular dependency. The histogram keeps monotonic per-bucket counters; it
// used to rebuild buckets from a 2000-sample window, which over-counted and
// made the series go down between scrapes (DB-13).
// =============================================================================

const { registry } = require('./metricsRegistry');

const dbQueryBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const dbQueryDuration = registry.histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: dbQueryBuckets,
  maxSeries: 50,
});

/**
 * Record a DB query duration.
 * @param {number} durationSeconds
 * @param {string} [operation='OTHER']
 */
function recordDbQuery(durationSeconds, operation = 'OTHER') {
  dbQueryDuration.observe({ operation }, durationSeconds);
}

// Connection pools (DB-25). database.js registers a reader of its pools; the
// values are read at scrape time.
let readPools = () => [];
function registerPoolStats(reader) {
  readPools = reader;
}

registry.collected({
  name: 'db_pool_connections',
  help: 'Database pool connections by state (in_use, idle)',
  collect: () => readPools().flatMap(p => [
    { labels: { pool: p.pool, state: 'in_use' }, value: p.inUse },
    { labels: { pool: p.pool, state: 'idle' }, value: p.idle },
  ]),
});

registry.collected({
  name: 'db_pool_connection_limit',
  help: 'Maximum connections of each database pool',
  collect: () => readPools().map(p => ({ labels: { pool: p.pool }, value: p.limit })),
});

registry.collected({
  name: 'db_pool_waiting_requests',
  help: 'Requests waiting for a connection from each database pool',
  collect: () => readPools().map(p => ({ labels: { pool: p.pool }, value: p.waiting })),
});

const poolAcquireWait = registry.histogram({
  name: 'db_pool_acquire_wait_seconds',
  help: 'Time spent waiting for a database pool connection',
  labelNames: ['pool'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10],
  maxSeries: 10,
});

const poolAcquireFailures = registry.counter({
  name: 'db_pool_acquire_failures_total',
  help: 'Requests refused a database connection (reason: timeout, queue_full)',
  labelNames: ['pool', 'reason'],
  maxSeries: 20,
});

function recordPoolAcquire(pool, waitSeconds) {
  poolAcquireWait.observe({ pool }, waitSeconds);
}

function notePoolAcquireFailure(pool, reason) {
  poolAcquireFailures.inc({ pool, reason });
}

module.exports = {
  recordDbQuery, dbQueryDuration, dbQueryBuckets, registerPoolStats, recordPoolAcquire, notePoolAcquireFailure,
};
