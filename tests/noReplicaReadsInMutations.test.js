// =============================================================================
// DB-12 — mutation handlers never read from the lagging replica
// =============================================================================
// Report-definition, dashboard-widget, custom-report and scheduled-report
// POST/PUT/DELETE handlers existence-checked and read back through
// queryReplica, so with DB_REPLICA_HOST set a create answered {} and an edit
// right after a create was a 404. Replica reads stay for lists and reports.

const fs = require('fs');
const path = require('path');

const FILES = ['reportDefinitions', 'dashboardWidgets', 'customReports', 'scheduledReports'];
// Read-only report execution, deliberately on the replica.
const ALLOWED = new Set(['customReports POST /:id/execute']);

function mutationHandlers(file) {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes', `${file}.js`), 'utf8');
  const starts = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)];
  return starts.map((m, i) => ({
    method: m[1].toUpperCase(),
    route: m[2],
    body: src.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : src.length),
  })).filter(h => h.method !== 'GET');
}

test.each(FILES)('%s mutations use the primary', (file) => {
  const offenders = mutationHandlers(file)
    .filter(h => !ALLOWED.has(`${file} ${h.method} ${h.route}`))
    .filter(h => /queryReplica\(/.test(h.body))
    .map(h => `${h.method} ${h.route}`);
  expect(offenders).toEqual([]);
});

test('POST /reports/generate reads back the generated row from the primary', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/reports.js'), 'utf8');
  const generate = src.slice(src.indexOf("router.post('/generate'"));
  expect(generate.slice(0, generate.indexOf('router.', 10))).not.toMatch(/queryReplica\(/);
});
