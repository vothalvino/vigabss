// =============================================================================
// MySQL has to fit in its container
// =============================================================================
// The database containers are limited to a fixed amount of memory. mysqld
// allocates its buffer pool and log buffer up front and, with the performance
// schema on, a few hundred megabytes more. Configured for more than the limit
// allows, it is killed by the kernel whenever it fills up: on a 1 GB limit
// with a 512M pool, about twice a day. This pins the budget so a later edit
// of either file cannot put it back.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.prod.yml'), 'utf8');

const MB = { K: 1 / 1024, M: 1, G: 1024 };
const megabytes = (value) => {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG])/i.exec(String(value).trim());
  if (!m) throw new Error(`not a size: ${value}`);
  return Number(m[1]) * MB[m[2].toUpperCase()];
};
const setting = (cnf, name) => {
  const m = new RegExp(`^${name}\\s*=\\s*(\\S+)`, 'm').exec(cnf);
  return m ? m[1] : null;
};
/** The memory limit of one compose service, in megabytes. */
function limitOf(service) {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start).toBeGreaterThan(-1);
  const body = compose.slice(start + 1, compose.indexOf('\n  # ──', start + 10));
  const m = /limits:\s*\n\s*cpus:[^\n]*\n\s*memory:\s*(\S+)/.exec(body);
  expect(m).not.toBeNull();
  return megabytes(m[1]);
}

describe.each([
  ['db-primary', 'primary.cnf'],
  ['db-replica', 'replica.cnf'],
])('%s', (service, file) => {
  const cnf = fs.readFileSync(path.join(ROOT, 'mysql', file), 'utf8');
  const limit = limitOf(service);
  const pool = megabytes(setting(cnf, 'innodb-buffer-pool-size'));
  const logBuffer = megabytes(setting(cnf, 'innodb-log-buffer-size'));

  test('what mysqld allocates up front leaves at least half the container free', () => {
    expect(pool + logBuffer).toBeLessThanOrEqual(limit / 2);
  });

  test('the performance schema is off: it costs a quarter of the container and nothing reads it', () => {
    expect(setting(cnf, 'performance-schema')).toBe('OFF');
  });

  test('the buffer pool is still a useful size', () => {
    expect(pool).toBeGreaterThanOrEqual(256);
  });
});

test('redeploy applies a changed database configuration, since mysqld reads it only at start', () => {
  const redeploy = fs.readFileSync(path.join(ROOT, 'redeploy.sh'), 'utf8');
  expect(redeploy).toMatch(/reload_database_config\(\) \{/);
  // Only once the app is drained, and before anything is backed up or migrated.
  const drained = redeploy.indexOf('dc stop -t 30 app');
  const reload = redeploy.indexOf('if ! reload_database_config; then');
  const backup = redeploy.indexOf('preMigrationBackup.js');
  expect(drained).toBeGreaterThan(-1);
  expect(reload).toBeGreaterThan(drained);
  expect(backup).toBeGreaterThan(reload);
});
