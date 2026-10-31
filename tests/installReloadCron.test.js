// =============================================================================
// SUP-01 — scheduling the host-nginx reload never stops the installer
// =============================================================================
// install.sh edited root's crontab with
//   ( crontab -l | grep -v <marker> ; echo <line> ) | crontab -
// under `set -euo pipefail`. With no crontab, an empty one, or only the
// VigaBSS line, grep -v selected nothing, exited 1, and the install stopped
// with no output. The reload now goes to /etc/cron.d, and old root-crontab
// entries are removed only when present. Runs the real script with a
// stubbed `crontab` on PATH.
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'nginx', 'install-reload-cron.sh');
const OLD_LINE = '0 */6 * * * /usr/sbin/nginx -s reload 2>/dev/null || true  # vigabss-nginx-reload';
const LEGACY_LINE = '0 */6 * * * /usr/sbin/nginx -s reload 2>/dev/null || true  # fireisp-nginx-reload';

function run(initialCrontab) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-cron-'));
  const cronDir = path.join(dir, 'cron.d');
  const bin = path.join(dir, 'bin');
  const store = path.join(dir, 'crontab.txt');
  fs.mkdirSync(cronDir);
  fs.mkdirSync(bin);
  if (initialCrontab !== null) fs.writeFileSync(store, initialCrontab);
  // `crontab -l` fails with "no crontab for root" when none exists, like the real one.
  fs.writeFileSync(path.join(bin, 'crontab'), `#!/usr/bin/env bash
if [[ "$1" == "-l" ]]; then
  [[ -f "${store}" ]] || { echo "no crontab for root" >&2; exit 1; }
  cat "${store}"
elif [[ "$1" == "-" ]]; then
  cat > "${store}.tmp" && mv "${store}.tmp" "${store}"
fi
`, { mode: 0o755 });
  execFileSync('bash', [SCRIPT], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIGABSS_CRON_DIR: cronDir },
    stdio: 'pipe',
  });
  const cronFile = path.join(cronDir, 'vigabss-nginx-reload');
  return {
    cronFile: fs.readFileSync(cronFile, 'utf8'),
    mode: fs.statSync(cronFile).mode & 0o777,
    crontab: fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : null,
    leftovers: fs.readdirSync(cronDir).filter(f => f !== 'vigabss-nginx-reload'),
  };
}

test.each([
  ['no crontab', null, null],
  ['an empty crontab', '', ''],
  ['only the old VigaBSS line', `${OLD_LINE}\n`, ''],
  ['only the legacy FireISP line', `${LEGACY_LINE}\n`, ''],
])('with %s it succeeds and installs /etc/cron.d/vigabss-nginx-reload', (_label, initial, expectedCrontab) => {
  const result = run(initial);
  expect(result.cronFile).toMatch(/^0 \*\/6 \* \* \* root \/usr\/sbin\/nginx -s reload /m);
  expect(result.mode).toBe(0o644);
  expect(result.leftovers).toEqual([]);
  expect(result.crontab).toBe(expectedCrontab);
});

test("other root crontab lines are kept and the old VigaBSS line removed", () => {
  const result = run(`MAILTO=ops@example.com\n15 3 * * * /usr/local/bin/backup\n${OLD_LINE}\n`);
  expect(result.crontab).toBe('MAILTO=ops@example.com\n15 3 * * * /usr/local/bin/backup\n');
});

test('a crontab without VigaBSS lines is not rewritten', () => {
  const result = run('15 3 * * * /usr/local/bin/backup\n');
  expect(result.crontab).toBe('15 3 * * * /usr/local/bin/backup\n');
});

test('install.sh uses the script and reports the failing line under errexit', () => {
  const install = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  expect(install).toContain('bash "$INSTALL_DIR/nginx/install-reload-cron.sh"');
  expect(install).not.toMatch(/crontab -l 2>\/dev\/null \| grep -v/);
  expect(install).toMatch(/^trap '.*\$LINENO.*' ERR$/m);
});
