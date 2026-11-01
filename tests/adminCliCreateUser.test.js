'use strict';
// =============================================================================
// DB-17 — the admin CLI creates accounts that can use the API
// =============================================================================
// create-user inserted a users row with no organization_id and no
// organization_users membership, so the account logged in to a JWT with no
// orgId and every API call failed. reset-password also left a lockout in
// place, though recovering a locked-out account is what it is for.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), close: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hashed') }));

const db = require('../src/config/database');
const { createUser, resetPassword } = require('../src/scripts/admin');

let exit;
beforeEach(() => {
  db.query.mockReset();
  process.env.VIGABSS_ADMIN_PASSWORD = 'correct-horse-9';
  exit = jest.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
});
afterEach(() => {
  delete process.env.VIGABSS_ADMIN_PASSWORD;
  exit.mockRestore();
});

function wire(orgs) {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM users WHERE email/.test(sql)) return [[]];
    if (/FROM organizations WHERE id = \?/.test(sql)) return [orgs.filter(o => o.id === params[0])];
    if (/FROM organizations/.test(sql)) return [orgs.slice(0, 2)];
    if (/^\s*INSERT INTO users/.test(sql)) return [{ insertId: 77 }];
    return [{ affectedRows: 1 }];
  });
}
const call = (re) => db.query.mock.calls.find(([sql]) => re.test(sql));

test('on a single-organization install the account joins that organization', async () => {
  wire([{ id: 4, name: 'Acme ISP' }]);
  await createUser({ email: 'ops@acme.test', role: 'admin' });
  const [userSql, userParams] = call(/^\s*INSERT INTO users/);
  expect(userSql).toMatch(/organization_id/);
  expect(userParams[0]).toBe(4);
  const [, memberParams] = call(/INSERT IGNORE INTO organization_users/);
  expect(memberParams).toEqual([4, 77, 'admin']);
});

test('with several organizations, --org is required', async () => {
  wire([{ id: 4, name: 'Acme ISP' }, { id: 5, name: 'Beta ISP' }]);
  await expect(createUser({ email: 'ops@acme.test' })).rejects.toThrow('exit 1');
  expect(call(/INSERT INTO users/)).toBeUndefined();
});

test('--org picks the organization, and an unknown id is refused', async () => {
  wire([{ id: 4, name: 'Acme ISP' }, { id: 5, name: 'Beta ISP' }]);
  await createUser({ email: 'ops@beta.test', role: 'billing', org: '5' });
  expect(call(/INSERT IGNORE INTO organization_users/)[1]).toEqual([5, 77, 'billing']);

  db.query.mockClear();
  await expect(createUser({ email: 'x@y.test', org: '99' })).rejects.toThrow('exit 1');
  expect(call(/INSERT INTO users/)).toBeUndefined();
});

test('reset-password clears the lockout', async () => {
  db.query.mockImplementation(async (sql) => (/FROM users WHERE email/.test(sql) ? [[{ id: 77 }]] : [{ affectedRows: 1 }]));
  await resetPassword({ email: 'ops@acme.test' });
  expect(call(/UPDATE users SET password_hash/)[0]).toMatch(/failed_login_attempts = 0, locked_until = NULL/);
});
