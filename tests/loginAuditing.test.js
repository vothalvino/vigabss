// =============================================================================
// Every sign-in is audited with its IP (migration 013)
// =============================================================================
// Staff (authService.login / completeMfaLogin) and portal
// (portalAuthService.login) sign-ins write login_success / login_failed /
// login_mfa_failed / account_locked and portal_login_* through
// loginSecurityService.record, count every failure against the IP
// (noteFailure), and give the person the same answer as before. The session
// row keeps the IP and browser.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn((fn) => fn()),
  withTenantContext: jest.fn((_org, fn) => fn()),
}));
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => '$2a$hash'), compare: jest.fn() }));
jest.mock('../src/services/loginSecurityService', () => ({
  record: jest.fn(async () => {}),
  noteFailure: jest.fn(async () => null),
}));
jest.mock('../src/services/passwordPolicyService', () => {
  const actual = jest.requireActual('../src/services/passwordPolicyService');
  return { ...actual, loadPolicy: jest.fn(async () => ({ ...actual.DEFAULT_POLICY, lockout_attempts: 5, lockout_duration_minutes: 15 })) };
});
jest.mock('../src/services/organizationFanOut', () => ({ isolatedOrganizationIds: jest.fn(async () => []) }));

const db = require('../src/config/database');
const bcrypt = require('bcryptjs');
const ls = require('../src/services/loginSecurityService');
const authService = require('../src/services/authService');
const portalAuthService = require('../src/services/portalAuthService');

const CTX = { ip: '203.0.113.7', userAgent: 'Test browser' };
const actions = () => ls.record.mock.calls.map(([a]) => [a.action, a.extra && a.extra.reason]);

function staffUser(over = {}) {
  return {
    id: 8, email: 'staff@example.com', password_hash: '$2a$real', status: 'active', role: 'admin',
    organization_id: 3, failed_login_attempts: 0, locked_until: null, totp_enabled: 0, ...over,
  };
}

let sessionInserts;
function staffDb(user) {
  sessionInserts = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM users/.test(sql) && /email/.test(sql) && !/UPDATE/.test(sql)) return [user ? [user] : []];
    if (/INSERT INTO user_sessions/.test(sql)) { sessionInserts.push(params); return [{ insertId: 1 }]; }
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('staff sign-in', () => {
  test('an unknown email is audited as login_failed unknown_account and counted against the IP', async () => {
    staffDb(null);
    await expect(authService.login({ email: 'nobody@example.com', password: 'x' }, CTX)).rejects.toThrow('Invalid email or password');
    expect(actions()).toEqual([['login_failed', 'unknown_account']]);
    expect(ls.record.mock.calls[0][0]).toMatchObject({ organizationId: null, userId: null, email: 'nobody@example.com', ctx: CTX });
    expect(ls.noteFailure).toHaveBeenCalledWith(CTX.ip);
  });

  test('inactive and locked accounts get their own reason, under their organization', async () => {
    staffDb(staffUser({ status: 'inactive' }));
    await expect(authService.login({ email: 'staff@example.com', password: 'x' }, CTX)).rejects.toThrow();
    staffDb(staffUser({ locked_until: new Date(Date.now() + 60000) }));
    await expect(authService.login({ email: 'staff@example.com', password: 'x' }, CTX)).rejects.toThrow();
    expect(actions()).toEqual([['login_failed', 'inactive_account'], ['login_failed', 'account_locked']]);
    expect(ls.record.mock.calls[1][0]).toMatchObject({ organizationId: 3, userId: 8 });
  });

  test('a wrong password is login_failed; the one that locks the account also writes account_locked', async () => {
    staffDb(staffUser({ failed_login_attempts: 3 }));
    bcrypt.compare.mockResolvedValue(false);
    await expect(authService.login({ email: 'staff@example.com', password: 'bad' }, CTX)).rejects.toThrow('Invalid email or password');
    expect(actions()).toEqual([['login_failed', 'wrong_password']]);

    ls.record.mockClear();
    staffDb(staffUser({ failed_login_attempts: 4 }));
    await expect(authService.login({ email: 'staff@example.com', password: 'bad' }, CTX)).rejects.toThrow('Invalid email or password');
    expect(actions()).toEqual([['login_failed', 'wrong_password'], ['account_locked', undefined]]);
    expect(ls.record.mock.calls[1][0].extra).toEqual({ minutes: 15 });
  });

  test('an expired lock restarts the count, so the next failure does not lock again', async () => {
    staffDb(staffUser({ failed_login_attempts: 5, locked_until: new Date(Date.now() - 1000) }));
    bcrypt.compare.mockResolvedValue(false);
    await expect(authService.login({ email: 'staff@example.com', password: 'bad' }, CTX)).rejects.toThrow();
    expect(actions()).toEqual([['login_failed', 'wrong_password']]);
  });

  test('a success is login_success and the session keeps the IP and browser', async () => {
    staffDb(staffUser());
    bcrypt.compare.mockResolvedValue(true);
    const out = await authService.login({ email: 'staff@example.com', password: 'good' }, CTX);
    expect(out.accessToken).toBeDefined();
    expect(actions()).toEqual([['login_success', undefined]]);
    expect(ls.record.mock.calls[0][0].extra).toEqual({ method: 'password' });
    expect(sessionInserts).toHaveLength(1);
    expect(sessionInserts[0][3]).toBe(CTX.ip);
    expect(sessionInserts[0][4]).toBe(CTX.userAgent);
    expect(ls.noteFailure).not.toHaveBeenCalled();
  });
});

describe('portal sign-in', () => {
  function client(over = {}) {
    return {
      id: 70, organization_id: 3, name: 'A client', email: 'client@example.com', status: 'active',
      portal_password_hash: '$2a$portal', portal_login_attempts: 0, portal_locked_until: null, portal_token_version: 0, ...over,
    };
  }
  function portalDb(rows) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM clients/.test(sql) && /WHERE email = \?/.test(sql)) return [rows];
      return [[]];
    });
  }

  test('an unknown email is portal_login_failed in the install scope, counted against the IP', async () => {
    portalDb([]);
    await expect(portalAuthService.login({ email: 'nobody@example.com', password: 'x' }, CTX)).rejects.toThrow('Invalid email or password');
    expect(actions()).toEqual([['portal_login_failed', 'unknown_account']]);
    expect(ls.record.mock.calls[0][0]).toMatchObject({ organizationId: null, entityType: 'clients', entityId: null });
    expect(ls.noteFailure).toHaveBeenCalledWith(CTX.ip);
  });

  test('a client without portal access gets that reason, under its organization', async () => {
    portalDb([client({ portal_password_hash: null })]);
    await expect(portalAuthService.login({ email: 'client@example.com', password: 'x' }, CTX)).rejects.toThrow();
    expect(actions()).toEqual([['portal_login_failed', 'no_portal_access']]);
    expect(ls.record.mock.calls[0][0]).toMatchObject({ organizationId: 3, entityId: 70 });
  });

  test('the failure that locks the portal account also writes portal_account_locked', async () => {
    portalDb([client({ portal_login_attempts: 4 })]);
    bcrypt.compare.mockResolvedValue(false);
    await expect(portalAuthService.login({ email: 'client@example.com', password: 'bad' }, CTX)).rejects.toThrow();
    expect(actions()).toEqual([['portal_login_failed', 'wrong_password'], ['portal_account_locked', undefined]]);
    expect(ls.noteFailure).toHaveBeenCalledTimes(1);
  });

  test('a success is portal_login_success', async () => {
    portalDb([client()]);
    bcrypt.compare.mockResolvedValue(true);
    const out = await portalAuthService.login({ email: 'client@example.com', password: 'good' }, CTX);
    expect(out.accessToken).toBeDefined();
    expect(actions()).toEqual([['portal_login_success', undefined]]);
    expect(ls.noteFailure).not.toHaveBeenCalled();
  });
});
