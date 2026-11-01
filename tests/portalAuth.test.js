// =============================================================================
// VigaBSS 5.0 — Client Self-Service Portal Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// No organization uses an isolated database here, so the public auth
// endpoints search only the primary (the isolated path: portalTenantContext.test.js).
jest.mock('../src/services/organizationFanOut', () => ({
  ...jest.requireActual('../src/services/organizationFanOut'),
  isolatedOrganizationIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$12$hashedpw'),
  compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.access.token'),
  verify: jest.fn(),
}));

// The password-reset request route sends real transactional email — mock the
// transport so these tests never attempt a real SMTP connection and can
// assert on the send call directly (mirrors tests/routeIntegration.test.js's
// staff-side password-reset coverage).
jest.mock('../src/services/emailTransport', () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'test-message-id' }),
}));

const request = require('supertest');
const db = require('../src/config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const emailTransport = require('../src/services/emailTransport');
const portalAuthService = require('../src/services/portalAuthService');
const app = require('../src/app');

// ---------------------------------------------------------------------------
// portalAuthService.login
// ---------------------------------------------------------------------------

describe('portalAuthService.login()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws ValidationError when email is missing', async () => {
    await expect(portalAuthService.login({ email: '', password: 'pw' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws UnauthorizedError when client not found', async () => {
    db.query.mockResolvedValueOnce([[]]); // SELECT client
    await expect(portalAuthService.login({ email: 'x@example.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('throws UnauthorizedError when portal access not enabled', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
      status: 'active', portal_password_hash: null,
      portal_login_attempts: 0, portal_locked_until: null,
    }]]);
    await expect(portalAuthService.login({ email: 'alice@example.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('throws UnauthorizedError when account is locked', async () => {
    const future = new Date(Date.now() + 60_000);
    db.query.mockResolvedValueOnce([[{
      id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
      status: 'active', portal_password_hash: '$2a$12$x',
      portal_login_attempts: 5, portal_locked_until: future.toISOString(),
    }]]);
    await expect(portalAuthService.login({ email: 'alice@example.com', password: 'wrong' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('increments attempt counter on wrong password and throws', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
        status: 'active', portal_password_hash: '$2a$12$x',
        portal_login_attempts: 0, portal_locked_until: null,
      }]])
      .mockResolvedValueOnce([{}]); // UPDATE attempts
    bcrypt.compare.mockResolvedValue(false);

    await expect(portalAuthService.login({ email: 'alice@example.com', password: 'wrong' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // One atomic UPDATE: the database increments the counter (SEC-11).
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ELSE portal_login_attempts + 1 END'),
      [5, 15, 1],
    );
  });

  test.each([
    ['an inactive client', { status: 'inactive' }],
    ['a client without portal access', { portal_password_hash: null }],
    ['a locked account', { portal_locked_until: new Date(Date.now() + 600000) }],
  ])('%s gets the generic message and no counter write (SEC-11)', async (_label, extra) => {
    db.query.mockResolvedValueOnce([[{
      id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
      status: 'active', portal_password_hash: '$2a$12$x', portal_login_attempts: 0, portal_locked_until: null, ...extra,
    }]]);
    bcrypt.compare.mockResolvedValue(true);

    await expect(portalAuthService.login({ email: 'alice@example.com', password: 'correct' }))
      .rejects.toThrow('Invalid email or password');
    expect(db.query.mock.calls.some(([sql]) => /UPDATE clients/.test(sql))).toBe(false);
  });

  test('locks account after MAX_ATTEMPTS failures', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
        status: 'active', portal_password_hash: '$2a$12$x',
        portal_login_attempts: 4, portal_locked_until: null,
      }]])
      .mockResolvedValueOnce([{}]); // UPDATE with locked_until
    bcrypt.compare.mockResolvedValue(false);

    await expect(portalAuthService.login({ email: 'alice@example.com', password: 'wrong' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain('portal_locked_until');
  });

  test('returns tokens on successful login', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
        status: 'active', portal_password_hash: '$2a$12$x',
        portal_login_attempts: 0, portal_locked_until: null,
      }]])
      .mockResolvedValueOnce([{}])  // reset attempts
      .mockResolvedValueOnce([{ insertId: 10 }]); // INSERT refresh token

    bcrypt.compare.mockResolvedValue(true);

    const result = await portalAuthService.login({ email: 'alice@example.com', password: 'correct' });

    expect(result.accessToken).toBe('mock.access.token');
    expect(result.refreshToken).toBeTruthy();
    expect(result.client.email).toBe('alice@example.com');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'portal', sub: 1 }),
      // Portal-only derived key, never the staff JWT_SECRET string.
      expect.any(Buffer),
      expect.objectContaining({ audience: 'vigabss-portal' }),
    );
  });

  test('throws when client status is inactive', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 2, organization_id: 1, name: 'Bob', email: 'bob@example.com',
      status: 'inactive', portal_password_hash: '$2a$12$x',
      portal_login_attempts: 0, portal_locked_until: null,
    }]]);
    await expect(portalAuthService.login({ email: 'bob@example.com', password: 'pw' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

// ---------------------------------------------------------------------------
// portalAuthService.refreshToken
// ---------------------------------------------------------------------------

describe('portalAuthService.refreshToken()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws when token not provided', async () => {
    await expect(portalAuthService.refreshToken(undefined))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('throws when token not found in DB', async () => {
    db.query.mockResolvedValueOnce([[]]); // no matching token
    await expect(portalAuthService.refreshToken('sometoken'))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('rotates refresh token and returns new access token', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 10, client_id: 1, organization_id: 1, name: 'Alice',
      email: 'alice@example.com', status: 'active',
    }]]);  // SELECT valid token

    // Rotation (revoke + insert) runs in a transaction on a dedicated connection.
    const conn = {
      execute: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 1 }])   // atomic revoke claim
        .mockResolvedValueOnce([{ insertId: 11 }]),      // insert new
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    db.getConnection.mockResolvedValue(conn);

    const result = await portalAuthService.refreshToken('validtoken');

    expect(result.accessToken).toBe('mock.access.token');
    expect(result.refreshToken).toBeTruthy();
    // The revoke is the atomic claim: guarded on revoked_at IS NULL.
    expect(conn.execute.mock.calls[0][0]).toContain('revoked_at IS NULL');
    expect(conn.commit).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });

  test('loses the concurrent-redeem race cleanly: revoke claims 0 rows → 401, no second pair minted, txn rolled back', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 10, client_id: 1, organization_id: 1, name: 'Alice',
      email: 'alice@example.com', status: 'active',
    }]]);  // stale SELECT — row still visible to this request

    const conn = {
      execute: jest.fn().mockResolvedValueOnce([{ affectedRows: 0 }]),  // other request won the claim
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    db.getConnection.mockResolvedValue(conn);

    await expect(portalAuthService.refreshToken('validtoken'))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(conn.execute).toHaveBeenCalledTimes(1);  // no INSERT after a lost claim
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// portalAuthService.logout
// ---------------------------------------------------------------------------

describe('portalAuthService.logout()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does nothing when no token provided', async () => {
    await expect(portalAuthService.logout(undefined)).resolves.toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('revokes the refresh token', async () => {
    db.query.mockResolvedValueOnce([{}]);
    await portalAuthService.logout('sometoken');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('revoked_at'),
      expect.any(Array),
    );
  });
});

// ---------------------------------------------------------------------------
// portalAuthService.setPassword
// ---------------------------------------------------------------------------

describe('portalAuthService.setPassword()', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws ValidationError for short password', async () => {
    await expect(portalAuthService.setPassword(1, 'short'))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('hashes and stores the new password', async () => {
    db.query.mockResolvedValueOnce([{}]);
    await portalAuthService.setPassword(1, 'newpassword123');
    expect(bcrypt.hash).toHaveBeenCalledWith('newpassword123', 12);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('portal_password_hash'),
      expect.arrayContaining(['$2a$12$hashedpw', 1]),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/password-reset/request
// ---------------------------------------------------------------------------
// Anti-enumeration: unknown email, portal-never-enabled, and inactive-status
// must all fall through to the IDENTICAL generic response with no token
// generated and no email sent (see design decision #2 in the spec — forgot-
// password must never become a self-service enablement path for a portal
// account the ISP has not turned on).
// ---------------------------------------------------------------------------

describe('POST /portal/auth/password-reset/request', () => {
  beforeEach(() => jest.clearAllMocks());

  test('known, portal-enabled, active client — 200 generic message, updates token columns, emails a /portal/reset-password link', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
        status: 'active', portal_password_hash: '$2a$12$x',
      }]]) // SELECT client
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE token columns

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset/request')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that email exists');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE clients SET portal_reset_token_hash'),
      expect.any(Array),
    );

    expect(emailTransport.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com', subject: 'Password Reset Request' }),
    );
    const emailCall = emailTransport.sendEmail.mock.calls[0][0];
    expect(emailCall.html).toContain('/portal/reset-password?token=');
  });

  test('unknown email — same generic message, no UPDATE, no email (anti-enumeration)', async () => {
    db.query.mockResolvedValueOnce([[]]); // SELECT client — no match

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that email exists');
    expect(db.query).toHaveBeenCalledTimes(1); // SELECT only, no UPDATE
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });

  // WHK-10: a shared email used to be treated as a miss, so every account at
  // the address was locked out of reset for good. Each eligible account now
  // gets its own token and its own email, sent through its own organization;
  // the response is the same generic message either way.
  test('duplicate email across organizations sends each eligible account its own reset', async () => {
    db.query
      .mockResolvedValueOnce([[
        { id: 20, organization_id: 1, name: 'Tenant One', email: 'shared@example.com', status: 'active', portal_password_hash: '$2a$12$x' },
        { id: 21, organization_id: 2, name: 'Tenant Two', email: 'shared@example.com', status: 'active', portal_password_hash: '$2a$12$y' },
        { id: 22, organization_id: 3, name: 'Gone', email: 'shared@example.com', status: 'inactive', portal_password_hash: '$2a$12$z' },
      ]])
      .mockResolvedValue([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset/request')
      .send({ email: 'shared@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that email exists');
    expect(res.body.token).toBeUndefined();
    const tokenWrites = db.query.mock.calls.filter(([sql]) => /SET portal_reset_token_hash/.test(sql));
    expect(tokenWrites.map(([, p]) => [p[1], p[2]])).toEqual([[20, 1], [21, 2]]);
    expect(tokenWrites[0][1][0]).not.toBe(tokenWrites[1][1][0]);
    await new Promise(r => setTimeout(r, 0));
    expect(emailTransport.sendEmail).toHaveBeenCalledTimes(2);
    expect(emailTransport.sendEmail.mock.calls.map(([m]) => [m.clientId, m.organizationId])).toEqual([[20, 1], [21, 2]]);
  });

  test('known email, portal access never enabled (portal_password_hash NULL) — same generic message, no UPDATE, no email', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 2, organization_id: 1, name: 'Bob', email: 'bob@example.com',
      status: 'active', portal_password_hash: null,
    }]]);

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset/request')
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that email exists');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });

  test('known email, inactive status — same generic message, no UPDATE, no email', async () => {
    db.query.mockResolvedValueOnce([[{
      id: 3, organization_id: 1, name: 'Carla', email: 'carla@example.com',
      status: 'inactive', portal_password_hash: '$2a$12$x',
    }]]);

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset/request')
      .send({ email: 'carla@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If that email exists');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /portal/auth/password-reset
// ---------------------------------------------------------------------------

describe('POST /portal/auth/password-reset', () => {
  beforeEach(() => jest.clearAllMocks());

  test('valid unexpired token — 200, hashes new password, clears reset + lockout columns, revokes refresh tokens', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com',
        status: 'active', portal_reset_token_hash: 'x', portal_reset_token_expires: '2099-01-01 00:00:00',
      }]]) // SELECT by token hash
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE clients (password + clear reset/lockout)
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE portal_refresh_tokens revoke

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset')
      .send({ token: 'sometoken', password: 'newpassword123' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Password reset successfully');
    expect(bcrypt.hash).toHaveBeenCalledWith('newpassword123', 12);

    const updateClientsCall = db.query.mock.calls[1];
    expect(updateClientsCall[0]).toContain('portal_password_hash');
    expect(updateClientsCall[0]).toContain('portal_reset_token_hash = NULL');
    expect(updateClientsCall[0]).toContain('portal_login_attempts = 0');
    expect(updateClientsCall[0]).toContain('portal_locked_until = NULL');
    expect(updateClientsCall[0]).toMatch(/WHERE id = \? AND organization_id <=> \?/);
    expect(updateClientsCall[0]).toMatch(/portal_reset_token_hash = \? AND portal_reset_token_expires > NOW\(\)/);
    const expectedTokenHash = require('crypto')
      .createHash('sha256')
      .update('sometoken')
      .digest('hex');
    expect(updateClientsCall[1]).toEqual(['$2a$12$hashedpw', 1, 1, expectedTokenHash]);

    const revokeCall = db.query.mock.calls[2];
    expect(revokeCall[0]).toContain('portal_refresh_tokens');
    expect(revokeCall[0]).toContain('revoked_at = NOW()');
    expect(revokeCall[1]).toEqual([1]);
  });

  test('a lost scoped reset claim returns 401 and does not revoke refresh tokens', async () => {
    db.query
      .mockResolvedValueOnce([[
        {
          id: 1, organization_id: 7, name: 'Alice', email: 'alice@example.com',
          status: 'active', portal_reset_token_hash: 'x', portal_reset_token_expires: '2099-01-01 00:00:00',
        },
      ]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset')
      .send({ token: 'sometoken', password: 'newpassword123' });

    expect(res.status).toBe(401);
    expect(db.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = db.query.mock.calls[1];
    expect(updateSql).toMatch(/WHERE id = \? AND organization_id <=> \?/);
    expect(updateSql).toMatch(/portal_reset_token_hash = \?/);
    expect(updateParams.slice(0, 3)).toEqual(['$2a$12$hashedpw', 1, 7]);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE portal_refresh_tokens/.test(sql))).toBe(false);
  });

  test('expired or unknown token — 401, no mutation', async () => {
    db.query.mockResolvedValueOnce([[]]); // no matching, unexpired token

    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset')
      .send({ token: 'badtoken', password: 'newpassword123' });

    expect(res.status).toBe(401);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('password shorter than 8 chars — 422 before any DB hit', async () => {
    const res = await request(app)
      .post('/api/v1/portal/auth/password-reset')
      .send({ token: 'sometoken', password: 'short' });

    expect(res.status).toBe(422);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// portalAuth middleware
// ---------------------------------------------------------------------------

describe('portalAuth middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  const { portalAuthenticate } = require('../src/middleware/portalAuth');

  test('rejects missing Authorization header', done => {
    const req = { headers: {} };
    const next = jest.fn(err => {
      expect(err.code).toBe('UNAUTHORIZED');
      done();
    });
    portalAuthenticate(req, {}, next);
  });

  test('rejects non-portal token type', done => {
    jwt.verify.mockReturnValue({ sub: 1, orgId: 1, type: 'staff' });
    const req = { headers: { authorization: 'Bearer staff.token' } };
    const next = jest.fn(err => {
      expect(err.code).toBe('UNAUTHORIZED');
      done();
    });
    portalAuthenticate(req, {}, next);
  });

  test('rejects when client not found in DB', done => {
    jwt.verify.mockReturnValue({ sub: 999, orgId: 1, type: 'portal' });
    db.query.mockResolvedValueOnce([[]]); // no client
    const req = { headers: { authorization: 'Bearer portal.token' } };
    const next = jest.fn(err => {
      expect(err.code).toBe('UNAUTHORIZED');
      done();
    });
    portalAuthenticate(req, {}, next);
  });

  test('sets req.client on valid token', done => {
    jwt.verify.mockReturnValue({ sub: 1, orgId: 1, type: 'portal' });
    db.query.mockResolvedValueOnce([[{
      id: 1, organization_id: 1, name: 'Alice', email: 'alice@example.com', status: 'active',
    }]]);
    const req = { headers: { authorization: 'Bearer portal.valid' } };
    const next = jest.fn(() => {
      expect(req.client).toMatchObject({ id: 1, name: 'Alice' });
      done();
    });
    portalAuthenticate(req, {}, next);
  });
});

// WHK-10: login picks the account by password among those sharing an email.
describe('portal login with an email shared by several accounts', () => {
  const account = (id, orgId, hash, extra = {}) => ({
    id, organization_id: orgId, name: `Acct ${id}`, email: 'shared@example.com', status: 'active',
    portal_password_hash: hash, portal_login_attempts: 0, portal_locked_until: null, portal_token_version: 0, ...extra,
  });
  beforeEach(() => {
    db.query.mockReset();
    jwt.sign.mockClear();
    bcrypt.compare.mockImplementation(async (pw, hash) => hash === `hash-of-${pw}`);
  });

  test('logs in the one account whose password matches', async () => {
    db.query
      .mockResolvedValueOnce([[account(20, 1, 'hash-of-alpha'), account(21, 2, 'hash-of-bravo')]])
      .mockResolvedValue([{ affectedRows: 1, insertId: 5 }]);
    const result = await portalAuthService.login({ email: 'shared@example.com', password: 'bravo' });
    expect(result.client.id).toBe(21);
    expect(jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sub: 21, orgId: 2 }), expect.any(Buffer), expect.any(Object));
  });

  test('a password that matches two accounts stays ambiguous and fails closed', async () => {
    db.query.mockResolvedValueOnce([[account(20, 1, 'hash-of-same'), account(21, 2, 'hash-of-same')]]);
    await expect(portalAuthService.login({ email: 'shared@example.com', password: 'same' }))
      .rejects.toThrow('Invalid email or password');
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO portal_refresh_tokens/.test(sql))).toBe(false);
  });

  test('a wrong password counts against every account it was tried on', async () => {
    db.query
      .mockResolvedValueOnce([[account(20, 1, 'hash-of-alpha'), account(21, 2, 'hash-of-bravo'), account(22, 3, null)]])
      .mockResolvedValue([{ affectedRows: 1 }]);
    await expect(portalAuthService.login({ email: 'shared@example.com', password: 'wrong' }))
      .rejects.toThrow('Invalid email or password');
    const counted = db.query.mock.calls.filter(([sql]) => /portal_login_attempts \+ 1/.test(sql)).map(([, p]) => p[2]);
    expect(counted).toEqual([20, 21]);
  });
});
