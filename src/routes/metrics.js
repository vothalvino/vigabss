// =============================================================================
// VigaBSS 5.0 — Prometheus Metrics
// =============================================================================
// Prometheus metrics at /metrics, from utils/metricsRegistry (no external
// dependency). Every series the shipped alerts and dashboards query is
// exported here; tests/metricsContract.test.js keeps them in step (OPS-15).
// =============================================================================

const crypto = require('crypto');
const { Router } = require('express');
const { monitorEventLoopDelay } = require('perf_hooks');
const { registry } = require('../utils/metricsRegistry');
require('../utils/dbMetrics');
require('../utils/opsMetrics');
const { bearerToken } = require('../utils/bearerToken');

const router = Router();

const histogramBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Series are keyed by the matched route template, or 'unmatched', and their
// number is capped (OPS-01): keyed by the raw path, a client looping requests
// to random paths grew them without bound.
const MAX_SERIES = 500;
const UNMATCHED_PATH = 'unmatched';
const KNOWN_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// ---- HTTP ----
// http_requests_total carries status so the SLO recording rules
// (status=~"5..") have a numerator; it used to have no labels at all.
const httpRequests = registry.counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route template and status code',
  labelNames: ['method', 'path', 'status'],
  maxSeries: MAX_SERIES * 4,
});
const httpErrors = registry.counter({
  name: 'http_request_errors_total',
  help: 'HTTP responses with a 4xx or 5xx status',
  labelNames: ['method', 'path', 'status'],
  maxSeries: MAX_SERIES * 2,
});
const httpDuration = registry.histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: histogramBuckets,
  maxSeries: MAX_SERIES,
});
let inFlight = 0;
registry.collected({ name: 'http_active_connections', help: 'HTTP requests in flight', collect: () => inFlight });

// ---- Process and runtime ----
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
const mem = () => process.memoryUsage();
registry.collected({ name: 'process_uptime_seconds', help: 'Process uptime in seconds', collect: () => Number(process.uptime().toFixed(2)) });
registry.collected({ name: 'process_resident_memory_bytes', help: 'Resident memory size in bytes', collect: () => mem().rss });
registry.collected({
  name: 'process_cpu_seconds_total', help: 'User and system CPU time in seconds', type: 'counter',
  collect: () => { const { user, system } = process.cpuUsage(); return (user + system) / 1e6; },
});
registry.collected({ name: 'process_heap_used_bytes', help: 'V8 heap used in bytes', collect: () => mem().heapUsed });
registry.collected({ name: 'process_heap_total_bytes', help: 'V8 heap total in bytes', collect: () => mem().heapTotal });
registry.collected({ name: 'nodejs_heap_size_used_bytes', help: 'V8 heap used in bytes', collect: () => mem().heapUsed });
registry.collected({ name: 'nodejs_heap_size_total_bytes', help: 'V8 heap total in bytes', collect: () => mem().heapTotal });
registry.collected({
  name: 'nodejs_eventloop_lag_seconds', help: 'Mean event-loop delay since the previous scrape, in seconds',
  collect: () => { const lag = eventLoop.mean / 1e9; eventLoop.reset(); return Number.isFinite(lag) ? lag : 0; },
});
registry.collected({
  name: 'nodejs_eventloop_lag_p99_seconds', help: 'p99 event-loop delay since process start, in seconds',
  collect: () => eventLoop.percentile(99) / 1e9,
});
registry.collected({
  name: 'nodejs_active_handles_total', help: 'Number of active libuv handles',
  collect: () => (typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null),
});
registry.collected({
  name: 'nodejs_active_requests_total', help: 'Number of active libuv requests',
  collect: () => (typeof process._getActiveRequests === 'function' ? process._getActiveRequests().length : null),
});

// ---- Network operations (NET-28) ----
// The embedded RADIUS server and the SNMP trap receiver already keep
// monotonic counters; they are read at scrape time.
function radiusCounters() {
  const status = require('../services/radiusServerService').getStatus();
  return status.enabled ? status.counters : null;
}
const radiusCounter = (name, help, key) => registry.collected({
  name, help, type: 'counter',
  collect: () => { const c = radiusCounters(); return c ? c[key] : null; },
});
radiusCounter('radius_auth_request_total', 'RADIUS Access-Requests received', 'authRequests');
radiusCounter('radius_auth_accept_total', 'RADIUS Access-Accepts sent', 'accepts');
radiusCounter('radius_auth_reject_total', 'RADIUS Access-Rejects sent', 'rejects');
radiusCounter('radius_acct_request_total', 'RADIUS Accounting-Requests received', 'acctRequests');
registry.collected({
  name: 'radius_dropped_total', help: 'RADIUS datagrams dropped, by reason', type: 'counter',
  collect: () => {
    const c = radiusCounters();
    if (!c) return null;
    return [['auth', c.authDropped], ['acct', c.acctDropped], ['overload', c.droppedOverload],
      ['source_rate', c.droppedSourceRate], ['no_message_authenticator', c.droppedNoMessageAuth]]
      .map(([reason, value]) => ({ labels: { reason }, value }));
  },
});
function trapStatus() {
  const s = require('../services/snmpTrapReceiver').getStatus();
  return s.enabled ? s : null;
}
registry.collected({
  name: 'snmp_traps_accepted_total', help: 'SNMP traps accepted', type: 'counter',
  collect: () => trapStatus()?.accepted_total ?? null,
});
registry.collected({
  name: 'snmp_traps_dropped_total', help: 'SNMP traps dropped, by reason', type: 'counter',
  collect: () => {
    const s = trapStatus();
    if (!s) return null;
    return ['overload', 'rate', 'source_rate', 'unattributed', 'daily_quota']
      .map((reason) => ({ labels: { reason }, value: s[`dropped_${reason}_total`] }));
  },
});

function routeLabel(req) {
  if (!req.route || typeof req.route.path !== 'string') return UNMATCHED_PATH;
  return `${req.baseUrl || ''}${req.route.path}`;
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
 * Middleware to record request count, status and latency.
 * Mount on Express *before* route handlers.
 */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  inFlight += 1;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const method = KNOWN_METHODS.has(req.method) ? req.method : 'OTHER';
    const path = routeLabel(req);
    const status = String(res.statusCode || 0);
    httpRequests.inc({ method, path, status });
    if (res.statusCode >= 400) httpErrors.inc({ method, path, status });
    httpDuration.observe({ method, path }, durationSeconds);
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint.
 */
router.get('/', (req, res) => {
  if (!metricsAccessAllowed(req)) return res.status(404).json({ error: 'Not found' });
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(registry.render());
});

module.exports = {
  router, metricsMiddleware, metricsAccessAllowed, registry,
  httpRequests, httpErrors, httpDuration, MAX_SERIES,
};
