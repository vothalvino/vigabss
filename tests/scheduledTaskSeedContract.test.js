'use strict';
// =============================================================================
// ASY-35 — the scheduled tasks a fresh install seeds match what the runner does
// =============================================================================
// Tests dispatched tasks with a made-up organization id, so nothing checked the
// configuration the migrations actually seed: ten tasks were enabled although
// their handler only returned { deferred: true } (seven of them were among the
// 20 tasks that deadlocked the pool at one 5-minute mark), and schema.sql had
// 28 of the 68 seeded tasks.
// =============================================================================

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { migratedSeeds, schemaSeeds } = require('./helpers/scheduledTaskSeeds');

const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'taskRunner.js'), 'utf8');

// The body of each `case '<task>':` in runTask, following fall-through labels.
function dispatcherCases() {
  const start = runnerSource.indexOf('switch (taskName)');
  const body = runnerSource.slice(start, runnerSource.indexOf('    default:', start));
  const labels = [...body.matchAll(/case '([a-z0-9_]+)':/g)].map(m => ({ name: m[1], at: m.index, end: m.index + m[0].length }));
  const cases = new Map();
  labels.forEach((label, i) => {
    let j = i;
    while (j + 1 < labels.length && body.slice(labels[j].end, labels[j + 1].at).trim() === '') j++;
    cases.set(label.name, body.slice(labels[j].at, j + 1 < labels.length ? labels[j + 1].at : body.length));
  });
  return cases;
}

const ORGANIZATION_SCOPED = new Set(
  runnerSource.match(/const ORGANIZATION_SCOPED_TASK_NAMES = new Set\(\[([\s\S]*?)\]\)/)[1]
    .match(/'([a-z0-9_]+)'/g).map(s => s.slice(1, -1)),
);

// Install-wide (organization_id NULL) rows of org-bound tasks whose service
// reads a null organization as "every organization" (checked by reading each).
// Most of them drop the filter by hand, so they cover the primary database
// only and do not use orgScopeFilter (ARCHITECTURE.md "Scheduled and
// asynchronous work"); moving them to forEachDatabaseScope is open work.
const SWEEPS_WHEN_NULL = {
  radius_sync: 'syncAllAccounts / syncFreeradiusTables drop the org filter',
  populate_revenue_summary: 'revenueSummaryAggregator fans out',
  populate_network_health_snapshots: 'aggregateDay(null) groups by organization',
  alert_evaluation: 'runAlertEvaluation lists active organizations',
  apply_speed_windows: 'drops the org filter',
  check_certificate_expiry: 'drops the org filter',
  kick_duplicate_sessions: 'drops the org filter and groups by organization',
  nas_health_check: 'drops the org filter',
  scan_auth_failures: 'scans every database scope',
  rollover_balance_accrue: '(c.organization_id = ? OR ? IS NULL)',
  inventory_low_stock_check: '(? IS NULL OR i.organization_id = ?)',
  data_retention_compliance_check: 'drops the org filter',
  maintenance_window_expiry: 'drops the org filter',
  poll_pppoe_events: 'collectPppoeEvents(null) sweeps every organization',
  reconcile_gateway_payments: 'lists active organizations',
};

const seeds = migratedSeeds();
const cases = dispatcherCases();
const scheduled = seeds.filter(r => Number(r.is_enabled) === 1 && r.cron_expression);

test('the migrations seed the scheduled tasks this test reads', () => {
  expect(seeds.length).toBeGreaterThan(50);
  expect(seeds.find(r => r.task_name === 'billing_cycle')).toMatchObject({ cron_expression: '0 2 * * *', is_enabled: 1 });
  // Migration 489 replaced these with billing_cycle.
  expect(seeds.find(r => r.task_name === 'auto_generate_invoices').is_enabled).toBe(0);
});

test('every seeded task has a dispatcher case', () => {
  expect(seeds.map(r => r.task_name).filter(name => !cases.has(name))).toEqual([]);
});

test('no enabled task is a deferred stub', () => {
  const deferred = scheduled.filter(r => /deferred: true/.test(cases.get(r.task_name))).map(r => r.task_name);
  expect(deferred).toEqual([]);
});

test('every enabled cron expression is valid', () => {
  expect(scheduled.filter(r => !cron.validate(r.cron_expression)).map(r => r.task_name)).toEqual([]);
});

test('an install-wide row of an org-bound task covers every organization', () => {
  const unscoped = scheduled
    .filter(r => r.organization_id === null && ORGANIZATION_SCOPED.has(r.task_name))
    .filter(r => !/perOrganization|inEveryDatabase|forEachActiveOrganization|forEachDatabaseScope/.test(cases.get(r.task_name)))
    .map(r => r.task_name)
    .filter(name => !SWEEPS_WHEN_NULL[name]);
  expect(unscoped).toEqual([]);
  const stale = Object.keys(SWEEPS_WHEN_NULL).filter(name => !scheduled.some(r => r.task_name === name));
  expect(stale).toEqual([]);
});

test('schema.sql seeds the same tasks as the migrations', () => {
  const shape = rows => Object.fromEntries(rows.map(r => [
    `${r.task_name}|${r.organization_id ?? ''}`,
    `${r.cron_expression} enabled=${Number(r.is_enabled)}`,
  ]));
  expect(shape(schemaSeeds())).toEqual(shape(seeds));
});
