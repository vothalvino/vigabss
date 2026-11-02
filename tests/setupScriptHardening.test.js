// =============================================================================
// OPS-27 — setup.sh fails fast, keeps the Redis password out of argv, requires
// pnpm with the lockfile, and writes the dev .env as 0600
// =============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'setup.sh'), 'utf8');

function workspace({ withPnpm }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-setup-'));
  for (const f of ['setup.sh', '.env.example', '.env.prod.example']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (withPnpm) {
    fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*" >> "$PWD/pnpm.log"\n');
    fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  }
  // Only system tools: no pnpm, corepack or npm unless provided above.
  return { dir, env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } };
}

test('the script fails fast and no longer falls back to npm or uses sed for secrets', () => {
  expect(script).toMatch(/^set -euo pipefail$/m);
  expect(script).not.toMatch(/^\s*npm install/m);
  expect(script).not.toMatch(/^\s*sed -i/m);
});

test('dev setup installs with the frozen lockfile and writes .env as 0600', () => {
  const { dir, env } = workspace({ withPnpm: true });
  const run = spawnSync('bash', ['setup.sh'], { cwd: dir, env, encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(fs.readFileSync(path.join(dir, 'pnpm.log'), 'utf8')).toMatch(/install --frozen-lockfile/);
  expect(fs.statSync(path.join(dir, '.env')).mode & 0o777).toBe(0o600);
});

test('without pnpm or corepack the setup stops instead of using npm', () => {
  const { dir, env } = workspace({ withPnpm: false });
  const run = spawnSync('bash', ['setup.sh'], { cwd: dir, env, encoding: 'utf8' });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/pnpm is required/);
});

test('prod setup puts the generated Redis password into REDIS_URL', () => {
  const { dir, env } = workspace({ withPnpm: true });
  const run = spawnSync('bash', ['setup.sh', '--prod'], { cwd: dir, env, encoding: 'utf8' });
  expect(run.status).toBe(0);
  const vars = Object.fromEntries(fs.readFileSync(path.join(dir, '.env.prod'), 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  expect(vars.REDIS_PASSWORD).toMatch(/^[0-9a-f]{40}$/);
  expect(vars.REDIS_URL).toBe(`redis://:${vars.REDIS_PASSWORD}@redis:6379`);
});
