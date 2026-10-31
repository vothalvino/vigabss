// =============================================================================
// OPS-02 — only fully green commits are published as images
// =============================================================================
// publish-manifest needed container-scan only, so a main commit whose lint,
// Jest, Vitest, e2e or database jobs failed was still published and signed as
// :<sha> and :latest, which install, redeploy and the in-app Update pull.
// =============================================================================

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ci = yaml.load(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8'));
const manifest = ci.jobs['publish-manifest'];
const needs = [].concat(manifest.needs);

test.each([
  'container-scan', 'lint-and-test', 'frontend-test', 'e2e',
  'database-tests', 'migration-runner-tests', 'mariadb-compatibility',
])('publishing waits for %s', (job) => {
  expect(ci.jobs[job]).toBeDefined();
  expect(needs).toContain(job);
});

test('a failed or skipped test job skips publishing (no always() override)', () => {
  expect(manifest.if).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/);
});

test('every job publish-manifest waits for runs on main and version-tag pushes', () => {
  for (const job of needs) {
    const condition = ci.jobs[job].if || '';
    // Allowed: no condition, or one that only excludes pull requests.
    expect(condition === '' || /^github\.event_name != 'pull_request'$/.test(condition.trim())).toBe(true);
  }
});
