// =============================================================================
// VigaBSS — SEC-03: staff TOTP two-factor is enforced at sign-in
// =============================================================================
// Before the fix, authService.login() minted a full session for an account
// with totp_enabled=1 from the password alone, so 2FA protected nothing.
// These tests pin the two-step contract:
//   POST /auth/login     -> { mfa_required, mfa_token } and NO session/cookies
//   POST /auth/login/2fa -> session only after a valid TOTP or backup code
// and that the challenge token is never a staff credential.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn((callback) => callback()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$12$hashedpassword'),
  compare: jest.fn(),
}));

jest.mock('../src/services/emailTransport', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true }),
}));

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../src/config/database');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const authService = require('../src/services/authService');
const twoFactorService = require('../src/services/twoFactorService');
const {
  verifyStaffAccessToken,
  verifyMfaChallengeToken,
  signMfaChallengeToken,
} = require('../src/utils/accessTokens');

const SECRET = 'a'.repeat(40);
const PASSWORD_HASH = '$2a$12$hashedpassword';

function totpUser(overrides = {}) {
  return {
    id: 7,
    email: 'tech@example.com',
    password_hash: PASSWORD_HASH,
    status: 'active',
    role: 'technician',
    organization_id: 42,
    failed_login_attempts: 0,
    locked_until: null,
    totp_enabled: 1,
    totp_secret: SECRET,
    totp_backup_codes: null,
    totp_last_used_step: null,
    ...overrides,
  };
}

/**
 * Route db.query by statement so the tests assert behaviour, not call order.
 * Returns the list of executed SQL strings for inspection.
 */
function mockDb(user, { claimAffected = 1, orgs = [{ id: 42, name: 'Org' }] } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM users WHERE email = \?/.test(sql)) return [[user]];
    if (/SELECT \* FROM `users` WHERE id = \?/.test(sql)) return [[user]];
    if (/SELECT totp_secret, totp_enabled, totp_backup_codes, totp_last_used_step/.test(sql)) return [[user]];
    if (/SET totp_last_used_step = \?/.test(sql)) return [{ affectedRows: claimAffected }];
    if (/FROM organization_users ou/.test(sql)) return [orgs];
    return [{ affectedRows: 1 }];
  });
  return calls;
}

function currentCode() {
  return twoFactorService.generateTOTP(SECRET, Math.floor(Date.now() / 1000 / 30));
}

describe('SEC-03 — staff login with TOTP enabled', () => {
  beforeEach(() => {
    db.query.mockReset();
    bcrypt.compare.mockReset();
  });

  test('password login returns a second-factor challenge and creates no session', async () => {
    const calls = mockDb(totpUser({ failed_login_attempts: 2 }));
    bcrypt.compare.mockResolvedValueOnce(true);

    const result = await authService.login({ email: 'tech@example.com', password: 'pw' });

    expect(result.mfaRequired).toBe(true);
    expect(typeof result.mfaToken).toBe('string');
    expect(result.accessToken).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
    expect(calls.some(c => /INSERT INTO user_sessions/.test(c.sql))).toBe(false);
    expect(calls.some(c => /last_login_at = NOW\(\)/.test(c.sql))).toBe(false);
    // The lockout counter is NOT reset until the second factor succeeds, so a
    // stolen password cannot be used to grind codes.
    expect(calls.some(c => /failed_login_attempts = 0/.test(c.sql))).toBe(false);
  });

  test('the challenge token is not a staff access token', async () => {
    mockDb(totpUser());
    bcrypt.compare.mockResolvedValueOnce(true);
    const { mfaToken } = await authService.login({ email: 'tech@example.com', password: 'pw' });

    expect(() => verifyStaffAccessToken(mfaToken)).toThrow();
    const payload = verifyMfaChallengeToken(mfaToken);
    expect(payload).toMatchObject({ sub: 7, type: 'mfa', method: 'password' });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
  });

  test('a challenge forged with the staff signing key is not accepted as staff credential either', () => {
    const forged = jwt.sign({ sub: 7, type: 'mfa' }, config.jwt.secret, { algorithm: config.jwt.algorithm });
    expect(() => verifyStaffAccessToken(forged)).toThrow();
  });

  test('a staff access token is not accepted as a challenge', async () => {
    const access = jwt.sign({ sub: 7, orgId: 42 }, config.jwt.secret, { algorithm: config.jwt.algorithm });
    mockDb(totpUser());
    await expect(authService.completeMfaLogin({ mfaToken: access, code: currentCode() }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('completing the challenge with a valid TOTP issues the session', async () => {
    const calls = mockDb(totpUser({ failed_login_attempts: 2 }));
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    const result = await authService.completeMfaLogin({ mfaToken, code: currentCode() });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toHaveLength(64);
    expect(result.user.totp_secret).toBeUndefined();
    expect(jwt.decode(result.accessToken)).toMatchObject({ sub: 7, orgId: 42 });
    expect(result.activeOrganizationId).toBe(42);
    expect(calls.some(c => /INSERT INTO user_sessions/.test(c.sql))).toBe(true);
    expect(calls.some(c => /failed_login_attempts = 0/.test(c.sql))).toBe(true);
  });

  test('a backup code also completes the challenge', async () => {
    const hashed = crypto.createHash('sha256').update('ABCD-EF12').digest('hex');
    const calls = mockDb(totpUser({ totp_backup_codes: [hashed] }));
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    const result = await authService.completeMfaLogin({ mfaToken, code: 'ABCD-EF12' });
    expect(result.accessToken).toBeDefined();
    expect(calls.some(c => /JSON_REMOVE/.test(c.sql))).toBe(true);
  });

  test('a wrong code is 401, mints nothing and counts towards the lockout', async () => {
    const calls = mockDb(totpUser({ failed_login_attempts: 4 }));
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    await expect(authService.completeMfaLogin({ mfaToken, code: '000000' }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(calls.some(c => /INSERT INTO user_sessions/.test(c.sql))).toBe(false);
    // The shared counter is incremented atomically and locks at 5 (SEC-11).
    const lock = calls.find(c => /failed_login_attempts \+ 1/.test(c.sql) && /DATE_ADD/.test(c.sql));
    expect(lock).toBeDefined();
    expect(lock.params).toEqual([5, 15, 7]);
  });

  test('a replayed TOTP code (same step) cannot complete a second login', async () => {
    const calls = mockDb(totpUser(), { claimAffected: 0 });
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    await expect(authService.completeMfaLogin({ mfaToken, code: currentCode() }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(calls.some(c => /INSERT INTO user_sessions/.test(c.sql))).toBe(false);
  });

  test('a challenge issued before a password change is void', async () => {
    mockDb(totpUser({ password_hash: '$2a$12$a-new-password-hash' }));
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    await expect(authService.completeMfaLogin({ mfaToken, code: currentCode() }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('a locked account cannot complete a challenge', async () => {
    mockDb(totpUser({ locked_until: new Date(Date.now() + 60_000) }));
    const mfaToken = signMfaChallengeToken({ userId: 7, passwordHash: PASSWORD_HASH });

    await expect(authService.completeMfaLogin({ mfaToken, code: currentCode() }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('an SSO challenge stays bound to the SSO organization', async () => {
    const user = totpUser();
    mockDb(user, { orgs: [] });
    const { mfaToken } = authService.createSsoMfaChallenge(user, 99);
    expect(verifyMfaChallengeToken(mfaToken)).toMatchObject({ method: 'sso', orgId: 99 });

    // No membership in org 99 any more -> the challenge cannot open a session.
    await expect(authService.completeMfaLogin({ mfaToken, code: currentCode() }))
      .rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/selected organization/) });
  });

  test('an account without 2FA still logs in in one step (unchanged)', async () => {
    const calls = mockDb(totpUser({ totp_enabled: 0 }));
    bcrypt.compare.mockResolvedValueOnce(true);

    const result = await authService.login({ email: 'tech@example.com', password: 'pw' });
    expect(result.mfaRequired).toBeUndefined();
    expect(result.accessToken).toBeDefined();
    expect(calls.some(c => /INSERT INTO user_sessions/.test(c.sql))).toBe(true);
  });
});
