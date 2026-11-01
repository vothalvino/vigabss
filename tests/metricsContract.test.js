// =============================================================================
// OPS-15 / DB-13 / NET-28 — every metric the alerts and dashboards query exists,
// and histograms are valid
// =============================================================================
// http_requests_total had no labels, so the SLO numerators (status=~"5..")
// were empty and the SLO alerts never fired; radius_auth_* and
// fireisp_last_backup_timestamp_seconds were not exported; the dashboards
// queried nodejs_heap_size_used_bytes, http_active_connections and
// nodejs_eventloop_lag_seconds, none of which existed; and the histogram
// re-summed cumulative counts (le=10 read 11x the request count).
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue([[{ ts: null }]]) }));

const fs = require('fs');
const path = require('path');
const metrics = require('../src/routes/metrics');
const { recordDbQuery } = require('../src/utils/dbMetrics');
const { Histogram } = require('../src/utils/metricsRegistry');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// External exporters the shipped rules legitimately query.
const EXTERNAL = [/^mysql_global_/];
const KEYWORDS = new Set(['and', 'or', 'unless', 'bool', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'offset', 'inf', 'nan']);

function exported() {
  const names = new Set();
  for (const [, name, type] of metrics.registry.render().matchAll(/^# TYPE (\S+) (\S+)$/gm)) {
    names.add(name);
    if (type === 'histogram') ['_bucket', '_sum', '_count'].forEach((s) => names.add(name + s));
  }
  return names;
}

function metricNames(expr) {
  const stripped = expr
    .replace(/\{\{[^}]*\}\}/g, ' ')                 // Helm template placeholders
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')              // strings
    .replace(/\{[^}]*\}/g, ' ')                     // label matchers
    .replace(/\[[^\]]*\]/g, ' ')                    // range selectors
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  return [...stripped.matchAll(/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b(?!\s*\()/g)]
    .map((m) => m[1])
    .filter((n) => !KEYWORDS.has(n.toLowerCase()) && !/^\d/.test(n) && !/^[eE]\d*$/.test(n));
}

function yamlExprs(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)expr:\s*(.*)$/);
    if (!m) return;
    if (m[2] && m[2] !== '|') { out.push(m[2]); return; }
    const block = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) block.push(lines[j]);
    out.push(block.join('\n'));
  });
  return out.map((e) => e.replace(/^\s*#.*$/gm, ''));
}

function grafanaExprs(file) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (typeof o.expr === 'string') out.push(o.expr);
      Object.values(o).forEach(walk);
    }
  };
  walk(JSON.parse(read(file)));
  return out;
}

const sources = [
  ...['k8s/prometheus-alerts.yaml', 'charts/fireisp/templates/prometheus-alerts.yaml'].map((f) => [f, yamlExprs(read(f)), read(f)]),
  ...fs.readdirSync(path.join(root, 'docs/grafana')).filter((f) => f.endsWith('.json'))
    .map((f) => [`docs/grafana/${f}`, grafanaExprs(`docs/grafana/${f}`), '']),
];

test.each(sources)('every metric %s queries is exported (or recorded / external)', (_file, exprs, text) => {
  const names = exported();
  const recorded = new Set([...text.matchAll(/^\s*(?:-\s*)?record:\s*(\S+)/gm)].map((m) => m[1]));
  expect(exprs.length).toBeGreaterThan(0);
  const missing = [...new Set(exprs.flatMap(metricNames))]
    .filter((n) => !names.has(n) && !recorded.has(n) && !EXTERNAL.some((re) => re.test(n)));
  expect(missing).toEqual([]);
});

test('requests are counted by method, route template and status, so the 5xx numerators exist', () => {
  const req = { method: 'GET', route: { path: '/clients' }, baseUrl: '/api/v1' };
  const handlers = {};
  const res = { statusCode: 503, on: (ev, fn) => { handlers[ev] = fn; } };
  metrics.metricsMiddleware(req, res, () => {});
  handlers.finish();
  handlers.close(); // counted once
  expect(metrics.httpRequests.get({ method: 'GET', path: '/api/v1/clients', status: '503' })).toBe(1);
  expect(metrics.registry.render()).toMatch(/^http_requests_total\{method="GET",path="\/api\/v1\/clients",status="503"\} 1$/m);
});

test('a histogram is cumulative once, and its series only grow', () => {
  const h = new Histogram({ name: 't_seconds', help: 't', labelNames: ['k'], buckets: [0.01, 0.1, 10] });
  for (let i = 0; i < 5; i++) h.observe({ k: 'a' }, 0.002);
  h.observe({ k: 'a' }, 0.05);
  const lines = h.lines();
  expect(lines).toContain('t_seconds_bucket{k="a",le="0.01"} 5');
  expect(lines).toContain('t_seconds_bucket{k="a",le="0.1"} 6');
  expect(lines).toContain('t_seconds_bucket{k="a",le="10"} 6');
  expect(lines).toContain('t_seconds_bucket{k="a",le="+Inf"} 6');
  expect(lines).toContain('t_seconds_count{k="a"} 6');

  // Thousands more observations never lower any line (the old 1000/2000
  // sample window made _count and _bucket drop between scrapes).
  for (let i = 0; i < 3000; i++) h.observe({ k: 'a' }, 0.002);
  expect(h.lines()).toContain('t_seconds_count{k="a"} 3006');

  recordDbQuery(0.003, 'SELECT');
  expect(metrics.registry.render()).toMatch(/^db_query_duration_seconds_count\{operation="SELECT"\} \d+$/m);
});

test('the memory alerts sit below the 512Mi container limit', () => {
  for (const f of ['k8s/prometheus-alerts.yaml', 'charts/fireisp/templates/prometheus-alerts.yaml']) {
    expect(read(f)).not.toMatch(/process_resident_memory_bytes[^\n]*> 1\.5 \* 1024/);
  }
  expect(read('k8s/prometheus-alerts.yaml')).toMatch(/process_resident_memory_bytes\{job="fireisp"\} > 435 \* 1024 \* 1024/);
});

test('a successful backup and scheduled-task runs are exported', () => {
  const { noteBackupSuccess, noteTaskRun } = require('../src/utils/opsMetrics');
  noteBackupSuccess(new Date('2026-11-01T03:00:00Z'));
  noteTaskRun('database_backup', 'success');
  const out = metrics.registry.render();
  expect(out).toMatch(/^fireisp_last_backup_timestamp_seconds 1793502000$/m);
  expect(out).toMatch(/^scheduled_task_runs_total\{task="database_backup",status="success"\} 1$/m);
});
