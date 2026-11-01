// =============================================================================
// OPS-07 — vulnerability detection runs between commits and on every PR
// =============================================================================
// CI had no schedule, the lockfile scan ran only in the main-only job, the
// image SARIF went to an artifact, .trivyignore carried stale rationales with
// no expiry, and there was no SECURITY.md or Dependabot config.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const ci = read('.github/workflows/ci.yml');
const sched = read('.github/workflows/security-scan.yml');

// The text of one top-level job in ci.yml.
function job(name) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  if (start === -1) return null;
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

test('a scheduled, dispatchable workflow scans the lockfile and the published image', () => {
  expect(sched).toMatch(/schedule:\n\s+- cron: "[^"]+"/);
  expect(sched).toMatch(/\n {2}workflow_dispatch:/);
  expect(sched).toMatch(/scan-type: fs/);
  expect(sched).toMatch(/image-ref: \$\{\{ env\.RELEASE_IMAGE \}\}:latest/);
  expect(sched).toMatch(/gh issue create/);
});

test('the lockfile scan runs on pull requests, outside the main-only job', () => {
  const scan = job('dependency-scan');
  expect(scan).not.toBeNull();
  expect(scan).not.toMatch(/\n {4}if:/);
  expect(scan).toMatch(/scan-type: fs[\s\S]*exit-code: 1/);
  expect(job('lint-and-test')).not.toMatch(/scan-type: fs/);
});

test('container-scan publishes its SARIF to code scanning', () => {
  expect(job('container-scan')).toMatch(/uses: github\/codeql-action\/upload-sarif@/);
});

test('every .trivyignore entry has an expiry, and SECURITY.md and Dependabot exist', () => {
  const entries = read('.trivyignore').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  expect(entries.length).toBeGreaterThan(0);
  for (const e of entries) expect(e).toMatch(/^\S+ exp:\d{4}-\d{2}-\d{2}$/);
  expect(read('SECURITY.md')).toMatch(/Report a vulnerability/);
  const dependabot = read('.github/dependabot.yml');
  for (const eco of ['npm', 'github-actions', 'docker']) expect(dependabot).toContain(`package-ecosystem: ${eco}`);
});

test('pnpm.auditConfig.ignoreGhsas no longer hides advisories pnpm audit would report', () => {
  expect(JSON.parse(read('package.json')).pnpm.auditConfig).toBeUndefined();
});
