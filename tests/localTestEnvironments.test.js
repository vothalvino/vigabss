// =============================================================================
// OPS-18 — the documented local test environments can run
// =============================================================================
// docker-compose.test.yml built the production image, which has no
// devDependencies and deletes npx, then ran `npx jest`; the e2e app
// health-checked with wget, which bookworm-slim lacks, so it never became
// healthy and Playwright never started.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('the test runner builds the Dockerfile test stage and runs Jest through pnpm', () => {
  const runner = yaml.load(read('docker-compose.test.yml')).services['test-runner'];
  expect(runner.build).toEqual({ context: '.', target: 'test' });
  expect(runner.command).toMatch(/pnpm exec jest/);
  expect(runner.command).not.toMatch(/\bnpx\b/);
  expect(runner.command).toMatch(/tests\/run_tests\.sh/);
});

test('the Dockerfile test stage has devDependencies and a MySQL client, and is not the default target', () => {
  const dockerfile = read('Dockerfile');
  const stages = [...dockerfile.matchAll(/^FROM \S+(?: AS (\S+))?$/gm)].map((m) => m[1] || '(default)');
  expect(stages).toContain('test');
  expect(stages[stages.length - 1]).toBe('(default)');
  const testStage = dockerfile.slice(dockerfile.indexOf('AS test'), dockerfile.indexOf('# ── Stage 2'));
  expect(testStage).toMatch(/default-mysql-client/);
  expect(testStage).toMatch(/pnpm install --frozen-lockfile\n/);
  expect(testStage).not.toMatch(/--prod/);
});

test('the e2e app health check needs no wget or curl', () => {
  const check = yaml.load(read('docker-compose.e2e.yml')).services.app.healthcheck.test.join(' ');
  expect(check).not.toMatch(/\bwget\b|\bcurl\b/);
  expect(check).toMatch(/node -e .*health\/live/);
});

test.each(['docker-compose.test.yml', 'docker-compose.e2e.yml'])('%s has no obsolete version key', (file) => {
  expect(yaml.load(read(file))).not.toHaveProperty('version');
});
