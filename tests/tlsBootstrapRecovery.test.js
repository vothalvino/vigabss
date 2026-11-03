// =============================================================================
// SUP-05 — a failed Let's Encrypt bootstrap does not leave nginx on the
// ACME-only config while the installer reports success
// =============================================================================
// init-letsencrypt.sh restored nginx.conf with `mv`, giving it a new inode
// while the bootstrap container kept the old (ACME-only) one bind-mounted;
// install.sh's cleanup ran compose without --env-file, so it failed silently;
// later `up -d` never recreated the unchanged nginx; and success was printed
// after probing only the app.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`${name}() {`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

test('restoring nginx.conf keeps its inode, so a bind-mounted container sees the production config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-tls-'));
  const conf = path.join(dir, 'nginx.conf');
  const backup = path.join(dir, '.nginx.conf.bootstrap-backup');
  fs.writeFileSync(conf, 'bootstrap: acme only\n');
  fs.writeFileSync(backup, 'production config\n');
  const inode = fs.statSync(conf).ino;
  try {
    execFileSync('bash', ['-c', [
      'log() { :; }',
      extractFunction(read('nginx/init-letsencrypt.sh'), 'restore_nginx_conf'),
      'restore_nginx_conf',
    ].join('\n')], { env: { ...process.env, NGINX_CONF: conf, NGINX_CONF_BACKUP: backup } });
    expect(fs.readFileSync(conf, 'utf8')).toBe('production config\n');
    expect(fs.statSync(conf).ino).toBe(inode);
    expect(fs.existsSync(backup)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// SUP-14: the exit trap is executed, with a PATH-stubbed docker, instead of
// matched as text.
function runBootstrapExit({ startedNginx, fail }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-tls-exit-'));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'docker.log');
  const conf = path.join(dir, 'nginx.conf');
  const backup = path.join(dir, '.nginx.conf.bootstrap-backup');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\necho "$*" >> "${calls}"\n`, { mode: 0o755 });
  fs.writeFileSync(conf, 'bootstrap: acme only\n');
  fs.writeFileSync(backup, 'production config\n');
  const src = read('nginx/init-letsencrypt.sh');
  try {
    let status = 0;
    try {
      execFileSync('bash', ['-c', [
        'set -euo pipefail',
        'log() { :; }',
        'DOCKER_COMPOSE_CMD="docker compose -f compose.yml"',
        'BOOTSTRAP_NGINX_STARTED=0',
        extractFunction(src, 'restore_nginx_conf'),
        extractFunction(src, 'on_bootstrap_exit'),
        'trap on_bootstrap_exit EXIT',
        startedNginx ? 'BOOTSTRAP_NGINX_STARTED=1' : ':',
        // A failed certbot run, as under set -e in the real script.
        fail ? 'false' : 'true',
      ].join('\n')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NGINX_CONF: conf, NGINX_CONF_BACKUP: backup }, stdio: 'pipe' });
    } catch (err) {
      status = err.status;
    }
    return {
      status,
      docker: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
      conf: fs.readFileSync(conf, 'utf8'),
      backupLeft: fs.existsSync(backup),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a failed bootstrap restores the production config and removes the nginx container it started', () => {
  const src = read('nginx/init-letsencrypt.sh');
  expect(src).toMatch(/trap on_bootstrap_exit EXIT/);
  expect(src.indexOf('BOOTSTRAP_NGINX_STARTED=1')).toBeLessThan(src.indexOf('$DOCKER_COMPOSE_CMD up --no-deps -d --force-recreate nginx'));

  const failed = runBootstrapExit({ startedNginx: true, fail: true });
  expect(failed.status).toBe(1); // the failure still reaches install.sh
  expect(failed.docker).toBe('compose -f compose.yml rm -sf nginx\n');
  expect(failed.conf).toBe('production config\n');
  expect(failed.backupLeft).toBe(false);
});

test('a successful bootstrap, or a failure before nginx started, leaves the container alone', () => {
  for (const run of [runBootstrapExit({ startedNginx: true, fail: false }), runBootstrapExit({ startedNginx: false, fail: true })]) {
    expect(run.docker).toBe('');
    expect(run.conf).toBe('production config\n');
  }
});

test('the installer cleans up with --env-file, recreates nginx, and probes HTTPS before reporting success', () => {
  const src = read('install.sh');
  expect(src).not.toMatch(/docker compose -f "\$INSTALL_DIR\/docker-compose\.prod\.yml" \\\n\s+rm -sf nginx/);
  expect(src).toMatch(/! \$_COMPOSE_CMD rm -sf nginx/);
  expect(src).not.toMatch(/mv -f "\$_NGINX_CONF_BACKUP"/);
  const up = src.indexOf('$COMPOSE up -d --no-deps --force-recreate nginx');
  const probe = src.indexOf('curl -fksS -o /dev/null');
  const success = src.indexOf('is installed and running!');
  expect(up).toBeGreaterThan(-1);
  expect(probe).toBeGreaterThan(up);
  expect(success).toBeGreaterThan(probe);
});
