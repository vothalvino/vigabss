// =============================================================================
// OPS-03 — a fresh production install creates no demo tenant
// =============================================================================
// install.sh ran seed.js on every fresh install: "Demo ISP", the login
// admin@demo-isp.com, active 2025 contracts that were back-billed daily, and
// an ACTIVE NAS with the RADIUS secret 'testing123'. It now runs
// bootstrap.js, which creates only the operator's organization and admin.
// =============================================================================

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  baseConnectionConfig: {},
  pool: { end: jest.fn() },
}));
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'bcrypt-hash') }));

const db = require('../src/config/database');
const Organization = require('../src/models/Organization');
const { bootstrap, readOptions } = require('../src/scripts/bootstrap');

const ROOT = path.join(__dirname, '..');
const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');

beforeEach(() => {
  jest.restoreAllMocks();
  db.query.mockReset();
});

describe('bootstrap.js', () => {
  function fresh() {
    db.query.mockImplementation(async (sql) => {
      if (/FROM users WHERE role = 'admin'/.test(sql)) return [[]];
      if (/FROM organizations WHERE deleted_at IS NULL/.test(sql)) return [[]];
      if (/^\s*INSERT INTO users/.test(sql)) return [{ insertId: 1 }];
      return [{ affectedRows: 1 }];
    });
    return jest.spyOn(Organization, 'create').mockResolvedValue({ id: 1 });
  }

  test('creates only the organization and an install-operator admin with the given email', async () => {
    const create = fresh();
    const result = await bootstrap({ ADMIN_EMAIL: 'Ops@MiISP.mx', ADMIN_PASSWORD: 'S3cret-initial', ORG_NAME: 'Mi ISP', ORG_COUNTRY: 'mx' });

    expect(result).toEqual({ created: true, userId: 1, organizationId: 1 });
    expect(create).toHaveBeenCalledWith({ name: 'Mi ISP', country: 'MX', locale: 'MX', currency: 'MXN', status: 'active' });
    const [userSql, userParams] = db.query.mock.calls.find(([sql]) => /INSERT INTO users/.test(sql));
    expect(userSql).toMatch(/is_install_operator/);
    expect(userParams).toEqual(['ops@miisp.mx', 'bcrypt-hash', 1]);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain('S3cret-initial');
    const tables = db.query.mock.calls.map(([sql]) => (/INSERT (?:IGNORE )?INTO (\w+)/.exec(sql) || [])[1]).filter(Boolean);
    expect(tables.sort()).toEqual(['organization_users', 'users']);
  });

  test('an install that already has an administrator is left alone', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7, email: 'me@isp.example' }]]);
    const create = jest.spyOn(Organization, 'create');
    expect(await bootstrap({ ADMIN_EMAIL: 'other@isp.example' })).toEqual({ created: false, userId: 7 });
    expect(create).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{}, /ADMIN_EMAIL/],
    [{ ADMIN_EMAIL: 'not-an-email' }, /ADMIN_EMAIL/],
    [{ ADMIN_EMAIL: 'a@b.mx', ORG_COUNTRY: 'Mexico' }, /ORG_COUNTRY/],
  ])('refuses %j', (env, message) => {
    expect(() => readOptions(env)).toThrow(message);
  });
});

test('seed.js refuses to load demo data in production', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { seed } = require('../src/scripts/seed');
    await expect(seed()).rejects.toThrow(/refuses NODE_ENV=production/);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('the demo seed never creates an active NAS with a fixed secret', () => {
  const seedCode = fs.readFileSync(path.join(ROOT, 'src/scripts/seed.js'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  expect(seedCode).not.toContain('testing123');
  const seedSource = seedCode;
  expect(seedSource).toMatch(/'Main NAS', '10\.0\.0\.1', \?, 'mikrotik', 'inactive'/);
});

describe('install.sh', () => {
  test('a fresh install runs bootstrap.js, not the demo seed, with the operator email', () => {
    expect(install).not.toMatch(/node src\/scripts\/seed\.js/);
    expect(install).toMatch(/-e ADMIN_EMAIL="\$EMAIL" -e ORG_NAME="\$ORG_NAME" -e ORG_COUNTRY="\$ORG_COUNTRY"[\s\S]{0,40}app node src\/scripts\/bootstrap\.js/);
    expect(install).toMatch(/Admin email {3}:\$\{RESET\} \$\{_INITIAL_ADMIN_EMAIL:-admin@demo-isp\.com\}/);
  });

  test('remove_env_key drops the initial password and keeps every other line', () => {
    const start = install.indexOf('remove_env_key() {');
    const fn = install.slice(start, install.indexOf('\n}\n', start) + 3);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-env-'));
    const env = path.join(dir, '.env.prod');
    fs.writeFileSync(env, 'DOMAIN=isp.example\nADMIN_PASSWORD=Abc123xyz\nDB_PASSWORD=keep-me\nADMIN_PASSWORD=\n', { mode: 0o600 });
    execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\nremove_env_key "$1" ADMIN_PASSWORD`, 'x', env]);
    expect(fs.readFileSync(env, 'utf8')).toBe('DOMAIN=isp.example\nDB_PASSWORD=keep-me\n');
    expect(fs.statSync(env).mode & 0o777).toBe(0o600);

    fs.writeFileSync(env, "ADMIN_PASSWORD='first\nsecond'\nDB_PASSWORD=x\n");
    expect(() => execFileSync('bash', ['-c', `${fn}\nremove_env_key "$1" ADMIN_PASSWORD`, 'x', env], { stdio: 'pipe' })).toThrow();
    expect(fs.readFileSync(env, 'utf8')).toBe("ADMIN_PASSWORD='first\nsecond'\nDB_PASSWORD=x\n"); // unchanged
  });

  test('the password is removed after it has been shown', () => {
    expect(install).toMatch(/VIGABSS_BOOTSTRAP_STATE complete[\s\S]{0,200}remove_env_key "\$ENV_FILE" ADMIN_PASSWORD/);
  });
});
