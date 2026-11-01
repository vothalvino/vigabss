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

module.exports = { recordDbQuery, dbQueryDuration, dbQueryBuckets };
