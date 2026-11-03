'use strict';
// =============================================================================
// SEC-23 — typed staff tokens, refresh-token reuse detection, separate pepper
// =============================================================================
// Staff access tokens were bare { sub, orgId } signed with JWT_SECRET, so any
// token signed with that key and no portal or MFA marker authenticated a staff
// request. Rotation deleted (staff) or revoked (portal) the old refresh token,
// so a replayed copy looked like an unknown token and the session it was
// stolen from stayed live. The WhatsApp code pepper was the JWT secret itself.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
}));

const crypto = require('crypto');
const jsonwebtoken = require('jsonwebtoken');
const db = require('../src/config/database');
const config = require('../src/config');
const {
  signStaffAccessToken, verifyStaffAccessToken, STAFF_AUDIENCE, TOKEN_ISSUER,
} = require('../src/utils/accessTokens');
const authService = require('../src/services/authService');
const portalAuthService = require('../src/services/portalAuthService');

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const future = () => new Date(Date.now() + 86400000).toISOString();

beforeEach(() => jest.clearAllMocks());

describe('staff access tokens', () => {
  test('carry a type, the staff audience, the issuer and a jti', () => {
    const payload = jsonwebtoken.decode(signStaffAccessToken({ sub: 1, orgId: 2, tv: 0 }));
    expect(payload).toMatchObject({ sub: 1, orgId: 2, type: 'staff', aud: STAFF_AUDIENCE, iss: TOKEN_ISSUER });
    expect(payload.jti).toEqual(expect.any(String));
    expect(verifyStaffAccessToken(signStaffAccessToken({ sub: 1, orgId: 2 }))).toMatchObject({ sub: 1 });
  });

  test('a token signed with JWT_SECRET but without the staff claims is refused', () => {
    const bare = jsonwebtoken.sign({ sub: 1, orgId: 2 }, config.jwt.secret, { expiresIn: '1h' });
    expect(() => verifyStaffAccessToken(bare)).toThrow();

    const untyped = jsonwebtoken.sign({ sub: 1, orgId: 2 }, config.jwt.secret, {
      expiresIn: '1h', audience: STAFF_AUDIENCE, issuer: TOKEN_ISSUER,
    });
    expect(() => verifyStaffAccessToken(untyped)).toThrow('Invalid token type');

    const foreignIssuer = jsonwebtoken.sign({ sub: 1, orgId: 2, type: 'staff' }, config.jwt.secret, {
      expiresIn: '1h', audience: STAFF_AUDIENCE, issuer: 'someone-else',
    });
    expect(() => verifyStaffAccessToken(foreignIssuer)).toThrow();
  });
});

describe('staff refresh-token reuse', () => {
  test('rotation keeps the old row as consumed instead of deleting it', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 10, user_id: 1, token_family: 'fam', expires_at: future(), consumed_at: null }]])
      .mockResolvedValueOnce([[{ id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 4 }]])
      .mockResolvedValueOnce([[{ id: 4 }]]);
    const conn = { execute: jest.fn().mockResolvedValue([{ affectedRows: 1 }]), beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn() };
    db.getConnection.mockResolvedValue(conn);

    await authService.refreshToken('tok');

    const sqls = conn.execute.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toMatch(/UPDATE user_sessions SET consumed_at = NOW\(\) WHERE id = \? AND consumed_at IS NULL/);
    expect(sqls.some(sql => /DELETE FROM user_sessions WHERE id = \?/.test(sql))).toBe(false);
  });

  test('presenting a consumed token ends every session of its sign-in', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 10, user_id: 1, token_family: 'fam', expires_at: future(), consumed_at: new Date() }]])
      .mockResolvedValueOnce([{ affectedRows: 3 }]);

    await expect(authService.refreshToken('stolen-copy')).rejects.toThrow('Invalid or expired refresh token');

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE token_hash = ?'), [sha('stolen-copy')]);
    expect(db.query).toHaveBeenNthCalledWith(2, 'DELETE FROM user_sessions WHERE token_family = ?', ['fam']);
    expect(db.getConnection).not.toHaveBeenCalled();
  });
});

describe('portal refresh-token reuse', () => {
  test('presenting a rotated portal token ends every portal session of the client', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM portal_refresh_tokens prt/.test(sql)) {
        return [[{ id: 3, client_id: 77, organization_id: 4, status: 'active', revoked_at: new Date(), rotated_at: new Date() }]];
      }
      if (/organization_id/.test(sql) && /^\s*SELECT/i.test(sql)) return [[]]; // no isolated organizations
      return [{ affectedRows: 1 }];
    });

    await expect(portalAuthService.refreshToken('stolen-copy')).rejects.toThrow('Invalid or expired refresh token');

    const sqls = db.query.mock.calls.map(([sql, params]) => [sql, params]);
    expect(sqls).toEqual(expect.arrayContaining([
      ['UPDATE clients SET portal_token_version = portal_token_version + 1 WHERE id = ?', [77]],
      ['UPDATE portal_refresh_tokens SET revoked_at = NOW() WHERE client_id = ? AND revoked_at IS NULL', [77]],
    ]));
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('a token revoked by logout is refused without touching other sessions', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM portal_refresh_tokens prt/.test(sql)) {
        return [[{ id: 3, client_id: 77, organization_id: 4, status: 'active', revoked_at: new Date(), rotated_at: null }]];
      }
      if (/organization_id/.test(sql) && /^\s*SELECT/i.test(sql)) return [[]]; // no isolated organizations
      return [{ affectedRows: 1 }];
    });

    await expect(portalAuthService.refreshToken('logged-out')).rejects.toThrow('Invalid or expired refresh token');
    expect(db.query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(false);
  });
});

describe('own session management', () => {
  test('lists live sign-ins only and marks the current one', async () => {
    db.query.mockResolvedValueOnce([[
      { id: 5, token_hash: sha('mine'), ip_address: null, user_agent: null },
      { id: 6, token_hash: sha('other'), ip_address: null, user_agent: null },
    ]]);

    const rows = await authService.listSessions(1, 'mine');

    expect(db.query.mock.calls[0][0]).toMatch(/WHERE user_id = \? AND consumed_at IS NULL AND expires_at > NOW\(\)/);
    expect(rows).toEqual([
      { id: 5, ip_address: null, user_agent: null, current: true },
      { id: 6, ip_address: null, user_agent: null, current: false },
    ]);
  });

  test('ending a session is keyed by the caller and removes its whole sign-in', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(authService.revokeSession(1, 99)).rejects.toThrow('Session not found');
    expect(db.query.mock.calls[0][1]).toEqual([99, 1]);

    db.query.mockResolvedValueOnce([[{ id: 5, token_family: 'fam' }]]).mockResolvedValueOnce([{ affectedRows: 2 }]);
    await authService.revokeSession(1, 5);
    expect(db.query).toHaveBeenLastCalledWith('DELETE FROM user_sessions WHERE token_family = ? AND user_id = ?', ['fam', 1]);
  });
});

test('the WhatsApp code pepper is not the token signing key', () => {
  expect(config.whatsapp.otpPepper).not.toBe(config.jwt.secret);
  expect(config.whatsapp.otpPepper).toMatch(/^[0-9a-f]{64}$/);
});
