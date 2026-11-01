// =============================================================================
// SEC-17 — the organization password policy is enforced, not just stored
// =============================================================================
// password_policies rows were saved by PUT /security-admin/password-policy and
// shown on the Security page, but sign-in used a hard-coded 5 attempts / 15
// minutes and every password path checked only length >= 8.

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn(callback => callback()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
// A transparent stand-in for bcrypt: hash(x) = 'h:' + x.
jest.mock('bcryptjs', () => ({
  hash: jest.fn(async pw => `h:${pw}`),
  compare: jest.fn(async (pw, hash) => hash === `h:${pw}`),
}));
jest.mock('../src/services/sessionRevocation', () => ({ revokeUserSessions: jest.fn(async () => {}) }));

const db = require('../src/config/database');
const User = require('../src/models/User');
const authService = require('../src/services/authService');
const { hashPasswordField } = require('../src/middleware/hashPassword');
const { assertPasswordMeetsPolicy, DEFAULT_POLICY } = require('../src/services/passwordPolicyService');

const STRICT = {
  organization_id: 7,
  min_length: 12,
  require_uppercase: 1,
  require_lowercase: 1,
  require_digits: 1,
  require_special_chars: 1,
  max_repeated_chars: 2,
  rotation_days: 30,
  history_count: 3,
  lockout_attempts: 3,
  lockout_duration_minutes: 45,
  is_active: 1,
};

let policyRow;
let historyRows;
let user;

function route(sql) {
  if (/FROM password_policies/.test(sql)) return [policyRow ? [policyRow] : []];
  if (/FROM password_history/.test(sql)) return [historyRows];
  if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
  return [[]];
}

beforeEach(() => {
  jest.clearAllMocks();
  policyRow = { ...STRICT };
  historyRows = [];
  user = {
    id: 21,
    organization_id: 7,
    email: 'tech@example.com',
    status: 'active',
    password_hash: 'h:Current-pass-01',
    password_changed_at: new Date(),
    failed_login_attempts: 0,
    locked_until: null,
    must_change_password: 0,
  };
  db.query.mockImplementation(async sql => route(sql));
  jest.spyOn(User, 'findById').mockImplementation(async () => user);
  jest.spyOn(User, 'findByEmail').mockImplementation(async () => user);
});

afterEach(() => jest.restoreAllMocks());

const sqlCalls = re => db.query.mock.calls.filter(([sql]) => re.test(sql));

describe('composition rules', () => {
  test.each([
    ['Short-1a!', /at least 12 characters/],
    ['alllowercase-123', /uppercase/],
    ['ALLUPPERCASE-123', /lowercase/],
    ['No-digits-here!', /digit/],
    ['NoSymbols12345', /symbol/],
    ['Aaa-bbb-ccc-1234', /more than 2 times/],
  ])('rejects %s', (password, message) => {
    expect(() => assertPasswordMeetsPolicy(password, STRICT)).toThrow(message);
  });

  test('accepts a password that meets every rule', () => {
    expect(() => assertPasswordMeetsPolicy('Ab1-cd2-ef3-gh4', STRICT)).not.toThrow();
  });

  test('the built-in default is still 8 characters with no class rules', () => {
    expect(() => assertPasswordMeetsPolicy('abcdefgh', DEFAULT_POLICY)).not.toThrow();
    expect(() => assertPasswordMeetsPolicy('abcdefg', DEFAULT_POLICY)).toThrow(/at least 8 characters/);
  });
});

describe('password change and reset', () => {
  test('changePassword applies the user organization policy', async () => {
    await expect(authService.changePassword(21, 'Current-pass-01', 'weakpassword'))
      .rejects.toThrow(/at least 12 characters|uppercase/);
    expect(sqlCalls(/UPDATE users SET password_hash/)).toHaveLength(0);
  });

  test('changePassword refuses a password from the recorded history', async () => {
    historyRows = [{ password_hash: 'h:Older-pass-0123' }];
    await expect(authService.changePassword(21, 'Current-pass-01', 'Older-pass-0123'))
      .rejects.toThrow(/last 3 passwords/);
  });

  test('a successful change records the replaced hash and stamps password_changed_at', async () => {
    await authService.changePassword(21, 'Current-pass-01', 'Brand-new-pass-9');
    expect(sqlCalls(/INSERT INTO password_history/)[0][1]).toEqual([21, 'h:Current-pass-01']);
    expect(sqlCalls(/SET password_changed_at = NOW\(\)/)).toHaveLength(1);
  });

  test('resetPassword applies the policy too', async () => {
    db.query.mockImplementation(async (sql) => (/reset_token_hash = \?/.test(sql) && /^\s*SELECT/i.test(sql)
      ? [[user]] : route(sql)));
    await expect(authService.resetPassword('token', 'weakpassword')).rejects.toThrow(/Password must/);
    expect(sqlCalls(/UPDATE users\s+SET password_hash/)).toHaveLength(0);
  });
});

describe('sign-in', () => {
  test('a wrong password locks after the policy lockout_attempts for its duration', async () => {
    await expect(authService.login({ email: user.email, password: 'wrong' })).rejects.toThrow();
    const [, params] = sqlCalls(/failed_login_attempts = CASE/)[0];
    expect(params).toEqual([3, 45, 21]);
  });

  test('an expired password signs in only to be replaced', async () => {
    user.password_changed_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    user.totp_enabled = 1; // stop before session issuance; the flag is already written
    await authService.login({ email: user.email, password: 'Current-pass-01' });
    expect(sqlCalls(/SET must_change_password = 1 WHERE id = \?/)[0][1]).toEqual([21]);
  });

  test('without a stored policy the old 5 attempts / 15 minutes apply', async () => {
    policyRow = null;
    await expect(authService.login({ email: user.email, password: 'wrong' })).rejects.toThrow();
    expect(sqlCalls(/failed_login_attempts = CASE/)[0][1]).toEqual([5, 15, 21]);
  });
});

describe('administrator-set passwords', () => {
  test('hashPasswordField applies the request organization policy', async () => {
    const req = { orgId: 7, body: { password: 'weakpassword' } };
    const next = jest.fn();
    await hashPasswordField(req, {}, next);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 422 });
    expect(req.body.password_hash).toBeUndefined();
  });
});
