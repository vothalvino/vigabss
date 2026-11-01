// =============================================================================
// OPS-08 — redeploy verifies the image signature and deploys by digest
// =============================================================================
// redeploy (and the GUI deploy agent that runs it as root) pulled a mutable
// tag and started it; nothing checked the keyless cosign signature CI writes,
// so whoever could push or re-point a tag chose what production ran.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const REDEPLOY = path.join(__dirname, '..', 'redeploy.sh');
const DIGEST = 'ghcr.io/vothalvino/vigabss@sha256:' + 'a'.repeat(64);

function run({ cosign, mode, envFile = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-sign-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, '.env.prod'), envFile);
  fs.writeFileSync(path.join(dir, 'docker-compose.prod.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\n[ "$1 $2" = "image inspect" ] && echo "${DIGEST}"\nexit 0\n`, { mode: 0o755 });
  if (cosign !== undefined) {
    fs.writeFileSync(path.join(bin, 'cosign'), `#!/usr/bin/env bash\necho "$@" > "${dir}/cosign.args"\nexit ${cosign}\n`, { mode: 0o755 });
  }
  try {
    const res = spawnSync('bash', ['-c', [
      'source "$1"',
      'export VIGABSS_IMAGE=ghcr.io/vothalvino/vigabss:abc123',
      'verify_image_signature; rc=$?',
      'echo "IMAGE=$VIGABSS_IMAGE"',
      'exit $rc',
    ].join('\n'), 'bash', REDEPLOY], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: dir, VIGABSS_LIB_ONLY: '1', VIGABSS_DIR: dir,
        ...(mode ? { VIGABSS_VERIFY_SIGNATURE: mode } : {}),
      },
    });
    const args = fs.existsSync(path.join(dir, 'cosign.args')) ? fs.readFileSync(path.join(dir, 'cosign.args'), 'utf8') : null;
    return { ...res, args };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a verified image is deployed by digest, checked against this repo\'s CI identity', () => {
  const r = run({ cosign: 0 });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`IMAGE=${DIGEST}`);
  expect(r.args).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
  expect(r.args).toMatch(/--certificate-identity-regexp \^https:\/\/github\.com\/vothalvino\/vigabss\/\.github\/workflows\/ci\.yml@refs\/\(heads\/main\|tags\/v\.\*\)\$/);
  expect(r.args.trim().endsWith(DIGEST)).toBe(true);
});

test('a signature that does not verify stops the deploy', () => {
  const r = run({ cosign: 1 });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/not signed by this repository's CI/);
});

test('required refuses to deploy without cosign; auto warns and still pins the digest', () => {
  const required = run({ mode: 'required' });
  expect(required.status).not.toBe(0);
  expect(required.stderr).toMatch(/cosign is not installed/);

  const auto = run({});
  expect(auto.status).toBe(0);
  expect(auto.stderr).toMatch(/signature was NOT checked/);
  expect(auto.stdout).toContain(`IMAGE=${DIGEST}`);
});

test('the mode can be set in .env.prod, and off skips the check for a rollback', () => {
  const r = run({ cosign: 1, envFile: 'VIGABSS_VERIFY_SIGNATURE=off\n' });
  expect(r.status).toBe(0);
  expect(r.args).toBeNull();
  expect(r.stderr).toMatch(/signature check is OFF/);
});

test('the deploy calls the check after the pull and before anything starts', () => {
  const src = fs.readFileSync(REDEPLOY, 'utf8');
  const call = src.indexOf('verify_image_signature || exit 1');
  expect(call).toBeGreaterThan(src.indexOf('PULL_OUT="$(dc pull app 2>&1)"'));
  expect(call).toBeLessThan(src.indexOf('dc up -d db-primary redis'));
});
