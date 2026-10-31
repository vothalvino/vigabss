// =============================================================================
// VigaBSS 5.0 — Prometheus Metrics
// =============================================================================
// Lightweight Prometheus-compatible metrics endpoint at /metrics.
// No external dependency — generates text/plain Prometheus exposition format.
// =============================================================================

const crypto = require('crypto');
const { Router } = require('express');
const { dbQuerySamples, dbQueryBuckets } = require('../utils/dbMetrics');
const { bearerToken } = require('../utils/bearerToken');

const router = Router();

// ---------------------------------------------------------------------------
// Metric Counters
// ---------------------------------------------------------------------------
const counters = {
  http_requests_total: 0,
  http_request_errors_total: 0,
};

const histogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Series used to be keyed by the raw request path whenever no route matched
// (every 404, and any non-GET outside /api), and keys were never pruned, so
// a client looping requests to random paths grew this map without bound
// until the process, embedded RADIUS included, ran out of memory (OPS-01).
// Series are now keyed by the matched route template, or 'unmatched', and
// their number is capped.
const MAX_SERIES = 500;
const OVERFLOW_PATH = '__other__';
const UNMATCHED_PATH = 'unmatched';
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** @type {Map<string, { method: string, path: string, samples: number[] }>} */
const latencySamples = new Map();

function routeLabel(req) {
  if (!req.route || typeof req.route.path !== 'string') return UNMATCHED_PATH;
  return `${req.baseUrl || ''}${req.route.path}`;
}

function seriesFor(method, path) {
  let key = `${method} ${path}`;
  if (!latencySamples.has(key) && latencySamples.size >= MAX_SERIES) {
    path = OVERFLOW_PATH;
    key = `${method} ${path}`;
  }
  let series = latencySamples.get(key);
  if (!series) {
    series = { method, path, samples: [] };
    latencySamples.set(key, series);
  }
  return series;
}

/**
 * Who may read /metrics and /health?detail=true. They were open to the
 * internet. With METRICS_TOKEN set, the caller must send it as a Bearer
 * token; without it they are available outside production only.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function metricsAccessAllowed(req) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const provided = bearerToken(req);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Middleware to record request count and latency.
 * Mount on Express *before* route handlers.
 */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  counters.http_requests_total++;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const method = KNOWN_METHODS.has(req.method) ? req.method : 'OTHER';
    const { samples } = seriesFor(method, routeLabel(req));
    samples.push(durationMs / 1000); // store in seconds
    // Keep only last 1000 samples per route to bound memory
    if (samples.length > 1000) samples.shift();

    if (res.statusCode >= 400) {
      counters.http_request_errors_total++;
    }
  });

  next();
}

/**
 * Build histogram buckets for a set of samples.
 */
function buildHistogram(name, labels, samples, buckets) {
  const lines = [];
  let sum = 0;
  const bucketCounts = buckets.map(() => 0);

  for (const s of samples) {
    sum += s;
    for (let i = 0; i < buckets.length; i++) {
      if (s <= buckets[i]) {
        bucketCounts[i]++;
      }
    }
  }

  for (let i = 0; i < buckets.length; i++) {
    // Cumulative
    const cumulative = bucketCounts.slice(0, i + 1).reduce((a, b) => a + b, 0);
    lines.push(`${name}_bucket{${labels},le="${buckets[i]}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{${labels},le="+Inf"} ${samples.length}`);
  lines.push(`${name}_sum{${labels}} ${sum.toFixed(6)}`);
  lines.push(`${name}_count{${labels}} ${samples.length}`);

  return lines;
}

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint.
 */
router.get('/', (req, res) => {
  if (!metricsAccessAllowed(req)) return res.status(404).json({ error: 'Not found' });
  const lines = [];
  const mem = process.memoryUsage();
  const uptime = process.uptime();

  // ---- Process metrics ----
  lines.push('# HELP process_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${uptime.toFixed(2)}`);

  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);

  lines.push('# HELP process_heap_used_bytes V8 heap used in bytes');
  lines.push('# TYPE process_heap_used_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);

  lines.push('# HELP process_heap_total_bytes V8 heap total in bytes');
  lines.push('# TYPE process_heap_total_bytes gauge');
  lines.push(`process_heap_total_bytes ${mem.heapTotal}`);

  lines.push('# HELP nodejs_active_handles_total Number of active libuv handles');
  lines.push('# TYPE nodejs_active_handles_total gauge');
  lines.push(`nodejs_active_handles_total ${typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1}`);

  lines.push('# HELP nodejs_active_requests_total Number of active libuv requests');
  lines.push('# TYPE nodejs_active_requests_total gauge');
  lines.push(`nodejs_active_requests_total ${typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : -1}`);

  // ---- HTTP metrics ----
  lines.push('# HELP http_requests_total Total number of HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  lines.push(`http_requests_total ${counters.http_requests_total}`);

  lines.push('# HELP http_request_errors_total Total number of HTTP errors (4xx/5xx)');
  lines.push('# TYPE http_request_errors_total counter');
  lines.push(`http_request_errors_total ${counters.http_request_errors_total}`);

  // ---- Request latency histogram ----
  lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds');
  lines.push('# TYPE http_request_duration_seconds histogram');
  for (const { method, path, samples } of latencySamples.values()) {
    const labels = `method="${method}",path="${path.replace(/["\\\n]/g, '_')}"`;
    lines.push(...buildHistogram('http_request_duration_seconds', labels, samples, histogramBuckets));
  }

  // ---- DB query duration histogram ----
  lines.push('# HELP db_query_duration_seconds Database query duration in seconds');
  lines.push('# TYPE db_query_duration_seconds histogram');
  for (const [op, samples] of dbQuerySamples.entries()) {
    const labels = `operation="${op}"`;
    lines.push(...buildHistogram('db_query_duration_seconds', labels, samples, dbQueryBuckets));
  }

  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

module.exports = { router, metricsMiddleware, counters, metricsAccessAllowed, latencySamples, MAX_SERIES };
