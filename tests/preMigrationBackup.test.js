// =============================================================================
// OPS-14 — every database with a pending migration is dumped before migrating
// =============================================================================
// redeploy (and the unattended GUI Update) stopped the app and ran forward-only
// migrations with no backup; the scheduled backup covers only the primary
// database, while migrate.js also alters isolated tenant databases.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-premig-'));
const mockState = { schemas: {}, dumps: [], failDump: null };

jest.mock('../src/config/database', () => ({
  baseConnectionConfig: { host: 'db', port: 3306, user: 'u', password: 'p', database: 'vigabss' },
  close: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(async (cfg) => ({
    query: async (sql) => {
      const applied = mockState.schemas[cfg.database];
      if (/information_schema\.tables/.test(sql)) return [applied ? [{ 1: 1 }] : []];
      return [applied.map((filename) => ({ filename }))];
    },
    end: async () => {},
  })),
}));
jest.mock('../src/scripts/backup', () => ({
  BACKUP_DIR: require('path').join(require('os').tmpdir(), 'vigabss-premig-dir'),
  MIN_BACKUP_BYTES: 512,
  runDump: jest.fn(async ({ database, filepath }) => {
    if (mockState.failDump === database) throw new Error('mysqldump exited with code 2');
    mockState.dumps.push(database);
    require('fs').writeFileSync(filepath, Buffer.alloc(2048));
  }),
}));
jest.mock('../src/services/tenantDatabaseService', () => ({
  listIsolatedMigrationTargets: jest.fn(async () => [
    { organizationId: 7, database: 'tenant_7', connectionConfig: { host: 't', port: 3306, user: 'x', password: 'y', database: 'tenant_7' } },
  ]),
}));

const backupModule = require('../src/scripts/backup');
const { preMigrationBackup, SET_PREFIX } = require('../src/scripts/preMigrationBackup');

const files = fs.readdirSync(path.join(__dirname, '..', 'database', 'migrations')).filter((f) => f.endsWith('.sql'));

beforeEach(() => {
  fs.rmSync(backupModule.BACKUP_DIR, { recursive: true, force: true });
  mockState.dumps = [];
  mockState.failDump = null;
  delete process.env.PRE_MIGRATION_BACKUP;
});
afterAll(() => {
  fs.rmSync(backupModule.BACKUP_DIR, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the primary and every isolated tenant with a pending migration are dumped into one set', async () => {
  mockState.schemas = { vigabss: files.slice(0, -1), tenant_7: files.slice(0, -2) };
  const result = await preMigrationBackup({ includeIsolatedTenants: true });
  expect(result.skipped).toBe(false);
  expect(mockState.dumps).toEqual(['vigabss', 'tenant_7']);
  expect(path.basename(result.dir)).toMatch(new RegExp(`^${SET_PREFIX}`));
  expect(fs.readdirSync(result.dir).sort()).toEqual(['tenant_7.sql.gz', 'vigabss.sql.gz']);
});

test('nothing is dumped when no migration is pending, or for a fresh database', async () => {
  mockState.schemas = { vigabss: files, tenant_7: null };
  const result = await preMigrationBackup({ includeIsolatedTenants: true });
  expect(result.skipped).toBe(true);
  expect(mockState.dumps).toEqual([]);
});

test('a failed dump rejects, so the caller does not migrate', async () => {
  mockState.schemas = { vigabss: [], tenant_7: [] };
  mockState.failDump = 'tenant_7';
  await expect(preMigrationBackup({ includeIsolatedTenants: true })).rejects.toThrow(/mysqldump/);
});

test('only the newest three sets are kept', async () => {
  fs.mkdirSync(backupModule.BACKUP_DIR, { recursive: true });
  for (const d of ['2026-01-01T00-00-00', '2026-02-01T00-00-00', '2026-03-01T00-00-00', '2026-04-01T00-00-00']) {
    fs.mkdirSync(path.join(backupModule.BACKUP_DIR, `${SET_PREFIX}${d}`));
  }
  mockState.schemas = { vigabss: [] };
  await preMigrationBackup({ includeIsolatedTenants: false });
  const sets = fs.readdirSync(backupModule.BACKUP_DIR).filter((n) => n.startsWith(SET_PREFIX)).sort();
  expect(sets).toHaveLength(3);
  expect(sets[0]).toBe(`${SET_PREFIX}2026-03-01T00-00-00`);
});

test('PRE_MIGRATION_BACKUP=0 skips it', async () => {
  process.env.PRE_MIGRATION_BACKUP = '0';
  mockState.schemas = { vigabss: [] };
  expect(await preMigrationBackup()).toMatchObject({ skipped: true });
  expect(mockState.dumps).toEqual([]);
});

test('redeploy and installer reruns back up after stopping the app and before migrating', () => {
  const redeploy = fs.readFileSync(path.join(__dirname, '..', 'redeploy.sh'), 'utf8');
  const stop = redeploy.indexOf('dc stop -t 30 app');
  const backup = redeploy.indexOf('node src/scripts/preMigrationBackup.js');
  const migrate = redeploy.indexOf('node src/scripts/migrate.js');
  expect(stop).toBeGreaterThan(-1);
  expect(backup).toBeGreaterThan(stop);
  expect(migrate).toBeGreaterThan(backup);
  expect(redeploy.slice(backup, migrate)).toMatch(/dc start app/);

  const install = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
  expect(install.indexOf('node src/scripts/preMigrationBackup.js')).toBeLessThan(install.indexOf('node src/scripts/migrate.js'));
});
