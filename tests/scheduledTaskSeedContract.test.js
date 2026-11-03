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

// Install-wide (organization_id NULL) rows of org-bound tasks must fan out in
// the dispatcher (perOrganization / inEveryDatabase), so isolated tenants run
// in their own database and their stale primary rows are skipped. These
// handlers do that themselves; tests/installWideTaskScopes.test.js and their
// own tests cover them. A service that drops the filter by hand for NULL is
// not a fan-out.
const FANS_OUT_ITSELF = {
  alert_evaluation: 'runAlertEvaluation enters each active organization',
  scan_auth_failures: 'scanAuthFailures scans the primary, then each isolated database',
  poll_pppoe_events: 'collectPppoeEvents runs the primary, then each isolated database',
  reconcile_gateway_payments: 'reconcileOutstandingTransactions enters each active organization',
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
    .filter(name => !FANS_OUT_ITSELF[name]);
  expect(unscoped).toEqual([]);
  const stale = Object.keys(FANS_OUT_ITSELF).filter(name => !scheduled.some(r => r.task_name === name));
  expect(stale).toEqual([]);
});

test('schema.sql seeds the same tasks as the migrations', () => {
  const shape = rows => Object.fromEntries(rows.map(r => [
    `${r.task_name}|${r.organization_id ?? ''}`,
    `${r.cron_expression} enabled=${Number(r.is_enabled)}`,
  ]));
  expect(shape(schemaSeeds())).toEqual(shape(seeds));
});
