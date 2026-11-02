// =============================================================================
// OPS-26 — CI cancels superseded PR runs, bounds every job, and never waits
// on MySQL without a limit
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const source = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
const ci = yaml.load(source);

test('a newer push to a pull request cancels the older run, never on main', () => {
  expect(ci.concurrency.group).toBe('${{ github.workflow }}-${{ github.ref }}');
  expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
});

test.each(Object.keys(ci.jobs))('%s has a timeout', (job) => {
  expect(ci.jobs[job]['timeout-minutes']).toBeGreaterThan(0);
  expect(ci.jobs[job]['timeout-minutes']).toBeLessThanOrEqual(90);
});

test('no unbounded wait loop', () => {
  expect(source).not.toMatch(/until mysqladmin ping/);
});
