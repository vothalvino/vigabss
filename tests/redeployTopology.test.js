'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REDEPLOY = path.join(ROOT, 'redeploy.sh');
const INSTALL = path.join(ROOT, 'install.sh');
const TLS_BOOTSTRAP = path.join(ROOT, 'nginx', 'init-letsencrypt.sh');

function shellFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`Missing shell function: ${name}`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`Unterminated shell function: ${name}`);
  return source.slice(start, end + 2);
}

function installTopologyValue(envContents) {
  const source = fs.readFileSync(INSTALL, 'utf8');
  const helpers = source.slice(
    source.indexOf('get_env_value() {'),
    source.indexOf('# Atomically append an authoritative final assignment'),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-install-topology-'));
  const bin = path.join(dir, 'bin');
  const envFile = path.join(dir, '.env.prod');
  fs.mkdirSync(bin);
  fs.writeFileSync(envFile, envContents);
  // An empty help response exercises the conservative parser used on Compose
  // versions before `config --environment` was added.
  fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  try {
    return spawnSync('bash', ['-c', [
      'set -euo pipefail',
      helpers,
      'raw="$(get_compatible_env_value "$1" VIGABSS_HOST_NGINX FIREISP_HOST_NGINX)"',
      'normalize_boolean_value "$raw"',
    ].join('\n'), 'install-topology-test', envFile], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function topology(envContents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-topology-'));
  fs.writeFileSync(path.join(dir, '.env.prod'), envContents, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'docker-compose.prod.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.host-nginx.yml'), 'services: {}\n');
  try {
    return execFileSync('bash', ['-c', [
      'source "$1"',
      'resolve_host_nginx_mode',
      'printf "%s\\n" "${COMPOSE_ARGS[*]}"',
    ].join('; '), 'bash', REDEPLOY], {
      encoding: 'utf8',
      env: { ...process.env, VIGABSS_LIB_ONLY: '1', VIGABSS_DIR: dir },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('redeploy preserves the installer topology', () => {
  test('explicit host-nginx installs use the overlay on every redeploy step', () => {
    const output = topology('VIGABSS_HOST_NGINX=1\n');
    expect(output).toContain('docker-compose.prod.yml');
    expect(output).toContain('docker-compose.host-nginx.yml');
  });

  test('explicit bundled-nginx installs use only the production Compose file', () => {
    const output = topology('VIGABSS_HOST_NGINX=0\n');
    expect(output).toContain('docker-compose.prod.yml');
    expect(output).not.toContain('docker-compose.host-nginx.yml');
  });

  test('legacy topology markers remain supported for an existing install', () => {
    expect(topology('FIREISP_HOST_NGINX=1\n')).toContain('docker-compose.host-nginx.yml');
  });

  test('the canonical topology marker wins when both spellings exist', () => {
    expect(topology('FIREISP_HOST_NGINX=1\nVIGABSS_HOST_NGINX=0\n'))
      .not.toContain('docker-compose.host-nginx.yml');
  });

  test('an invalid persisted topology fails instead of guessing at production ports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-topology-invalid-'));
    fs.writeFileSync(path.join(dir, '.env.prod'), 'VIGABSS_HOST_NGINX=maybe\n');
    fs.writeFileSync(path.join(dir, 'docker-compose.prod.yml'), 'services: {}\n');
    try {
      const result = spawnSync('bash', ['-c', 'source "$1"; resolve_host_nginx_mode', 'bash', REDEPLOY], {
        encoding: 'utf8',
        env: { ...process.env, VIGABSS_LIB_ONLY: '1', VIGABSS_DIR: dir },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/not a recognised boolean/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fresh env files persist the topology and management commands install before TLS/startup', () => {
    const install = fs.readFileSync(INSTALL, 'utf8');
    expect(install).toContain('VIGABSS_HOST_NGINX=${USE_HOST_NGINX}');
    const commandAt = install.indexOf('REDEPLOY_BIN="/usr/local/bin/redeploy"');
    const tlsAt = install.indexOf('── TLS Certificates');
    const startAt = install.indexOf('── Starting VigaBSS');
    expect(commandAt).toBeGreaterThan(0);
    expect(commandAt).toBeLessThan(tlsAt);
    expect(commandAt).toBeLessThan(startAt);
    expect(install).toContain('HOST_NGINX_CONF_DST="/etc/nginx/conf.d/vigabss.conf"');
    expect(install).toContain('LEGACY_HOST_NGINX_CONF="/etc/nginx/conf.d/fireisp.conf"');
    expect(install).toMatch(/nginx -t[\s\S]+previous configuration was restored/i);
  });

  test('installer reruns read canonical topology first and retain the legacy fallback', () => {
    expect(installTopologyValue('FIREISP_HOST_NGINX=1\nVIGABSS_HOST_NGINX=0\n').stdout).toBe('0');
    expect(installTopologyValue('FIREISP_HOST_NGINX=on\n').stdout).toBe('1');
  });

  test('an invalid canonical installer topology fails closed instead of using a valid legacy value', () => {
    const result = installTopologyValue('VIGABSS_HOST_NGINX=maybe\nFIREISP_HOST_NGINX=1\n');
    expect(result.status).not.toBe(0);
  });

  test('installer topology persistence precedes SKIP_TLS and all host heuristics', () => {
    const install = fs.readFileSync(INSTALL, 'utf8');
    const persistedAt = install.indexOf(
      '_SAVED_HOST_NGINX_RAW="$(get_compatible_env_value "$ENV_FILE" VIGABSS_HOST_NGINX FIREISP_HOST_NGINX)"',
    );
    const skipTlsAt = install.indexOf('SKIP_TLS="${SKIP_TLS:-0}"');
    const heuristicAt = install.indexOf('if (( ! HOST_NGINX_TOPOLOGY_PERSISTED ))');
    const configAt = install.indexOf('if [[ -f /etc/nginx/conf.d/vigabss.conf');
    const portAt = install.indexOf('elif [[ "$SKIP_TLS" != "1" ]]', configAt);
    expect(persistedAt).toBeGreaterThan(0);
    expect(persistedAt).toBeLessThan(skipTlsAt);
    expect(skipTlsAt).toBeLessThan(heuristicAt);
    expect(install).toContain('USE_HOST_NGINX="$SAVED_HOST_NGINX"');
    expect(configAt).toBeGreaterThan(heuristicAt);
    expect(configAt).toBeLessThan(portAt);
  });

  test.each([
    [INSTALL, 'ensure_host_nginx_bootstrap_certificate', 'HOST_NGINX_BOOTSTRAP_CREATED=0'],
    [TLS_BOOTSTRAP, 'ensure_tls_bootstrap_certificate', ''],
  ])('%s bootstrap preserves a complete pair and rejects a half-pair', (script, functionName, setup) => {
    const source = fs.readFileSync(script, 'utf8');
    const fn = shellFunction(source, functionName);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-tls-pair-'));
    const halfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-tls-half-'));
    const run = target => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'log() { :; }',
      setup,
      fn,
      `${functionName} "$1" example.test`,
    ].join('\n'), 'tls-bootstrap-test', target], { encoding: 'utf8' });

    try {
      const first = run(dir);
      expect(first.status).toBe(0);
      const fullchain = path.join(dir, 'fullchain.pem');
      const privkey = path.join(dir, 'privkey.pem');
      expect(fs.statSync(fullchain).size).toBeGreaterThan(0);
      expect(fs.statSync(privkey).size).toBeGreaterThan(0);
      const originalFullchain = fs.readFileSync(fullchain);
      const originalPrivkey = fs.readFileSync(privkey);

      const rerun = run(dir);
      expect(rerun.status).toBe(0);
      expect(fs.readFileSync(fullchain)).toEqual(originalFullchain);
      expect(fs.readFileSync(privkey)).toEqual(originalPrivkey);

      const survivor = path.join(halfDir, 'fullchain.pem');
      fs.writeFileSync(survivor, 'keep-this-production-certificate\n');
      const incomplete = run(halfDir);
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toMatch(/incomplete/i);
      expect(fs.readFileSync(survivor, 'utf8')).toBe('keep-this-production-certificate\n');
      expect(fs.existsSync(path.join(halfDir, 'privkey.pem'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(halfDir, { recursive: true, force: true });
    }
  });

  test('fresh host-nginx config validation bootstraps TLS before nginx -t', () => {
    const install = fs.readFileSync(INSTALL, 'utf8');
    const hostSetupAt = install.indexOf('── Host Nginx Setup');
    const bootstrapAt = install.indexOf(
      'ensure_host_nginx_bootstrap_certificate "$INSTALL_DIR/nginx/certs" "$DOMAIN"',
      hostSetupAt,
    );
    const nginxTestAt = install.indexOf('if ! nginx -t;', bootstrapAt);
    expect(hostSetupAt).toBeGreaterThan(0);
    expect(bootstrapAt).toBeGreaterThan(hostSetupAt);
    expect(nginxTestAt).toBeGreaterThan(bootstrapAt);
    expect(install.slice(nginxTestAt, nginxTestAt + 900)).toMatch(/previous configuration was restored/i);
  });

  test('failed ACME retries retain a pre-existing pair and only create a fresh fallback otherwise', () => {
    const install = fs.readFileSync(INSTALL, 'utf8');
    const tlsAt = install.indexOf('── TLS Certificates');
    const stateAt = install.indexOf('_TLS_HAD_COMPLETE_PAIR=0', tlsAt);
    const acmeAt = install.indexOf('bash "$LETSENCRYPT_SCRIPT"', stateAt);
    const failedAt = install.indexOf('warn "Let\'s Encrypt TLS bootstrap failed."', acmeAt);
    const retainAt = install.indexOf('Existing TLS certificate/key pair retained', failedAt);
    const fallbackAt = install.indexOf('Fallback self-signed certificate created.', failedAt);
    expect(stateAt).toBeGreaterThan(tlsAt);
    expect(acmeAt).toBeGreaterThan(stateAt);
    expect(failedAt).toBeGreaterThan(acmeAt);
    expect(retainAt).toBeGreaterThan(failedAt);
    expect(fallbackAt).toBeGreaterThan(retainAt);
    expect(install.slice(failedAt, fallbackAt)).toMatch(/if \(\( _TLS_HAD_COMPLETE_PAIR \)\);[\s\S]+else/);

    const bootstrap = fs.readFileSync(TLS_BOOTSTRAP, 'utf8');
    const ensureAt = bootstrap.indexOf('ensure_tls_bootstrap_certificate "$CERTS_DIR" "$DOMAIN"');
    const acmeRequestAt = bootstrap.indexOf('Requesting Let\'s Encrypt certificate', ensureAt);
    expect(ensureAt).toBeGreaterThan(0);
    expect(acmeRequestAt).toBeGreaterThan(ensureAt);
  });

  test('a pulled redeploy-script change re-execs before selecting the image', () => {
    const script = fs.readFileSync(REDEPLOY, 'utf8');
    const pullAt = script.indexOf('git -C "$APP_DIR" pull --ff-only origin main');
    const reexecAt = script.indexOf('VIGABSS_REDEPLOY_REEXEC=1');
    const tagAt = script.indexOf('TAG="${1:-');
    expect(pullAt).toBeGreaterThan(0);
    expect(reexecAt).toBeGreaterThan(pullAt);
    expect(reexecAt).toBeLessThan(tagAt);
    expect(script).toContain('docker compose "${COMPOSE_ARGS[@]}"');
  });
});
