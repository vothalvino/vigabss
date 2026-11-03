'use strict';

// =============================================================================
// SUP-14 — the shell scripts are linted and their tests run on pull requests
// =============================================================================
// CI had no shellcheck step, and the tests that execute install/TLS/deploy
// failure branches ran only in lint-and-test, which skips pull requests. The
// shell-scripts job runs both on every PR and gates image publication.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

function job(name) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`Missing CI job ${name}`);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

test('the shell-scripts job runs on pull requests and lints every tracked script', () => {
  const shell = job('shell-scripts');
  expect(shell).not.toMatch(/^\s+if:/m);
  expect(shell).toMatch(/git ls-files -z '\*\.sh' \| xargs -0 shellcheck/);
  expect(ci).toMatch(/pull_request:\n\s+branches: \[main\]/);
});

test('it runs every test that executes a shell script', () => {
  const pattern = job('shell-scripts').match(/--testPathPatterns '([^']+)'/)[1];
  const re = new RegExp(pattern);
  const scripts = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const executing = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.test.js'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
      return /(spawn|execFile)(Sync)?\(\s*'bash'/.test(src)
        && scripts.some(s => src.includes(path.basename(s)));
    });
  expect(executing.length).toBeGreaterThan(3);
  expect(executing.filter(f => !re.test(`tests/${f}`))).toEqual([]);
});

test('image publication waits for it', () => {
  expect(job('publish-manifest')).toMatch(/needs:[\s\S]*- shell-scripts/);
});
