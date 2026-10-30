// =============================================================================
// VigaBSS 5.0 — SSO Service & Routes Tests (P2.1)
// =============================================================================

// ---------------------------------------------------------------------------
// Mock database
// ---------------------------------------------------------------------------
const mockQuery      = jest.fn();
const mockGetConn    = jest.fn();
const mockConnQuery  = jest.fn();
const mockConnRelease = jest.fn();
const mockConnBegin    = jest.fn();
const mockConnCommit   = jest.fn();
const mockConnRollback = jest.fn();

const mockOidcAuthorizationUrl = jest.fn(() => 'https://idp.example/authorize');
const mockOidcUserinfo = jest.fn();
const mockOidcClient = {
  authorizationUrl: mockOidcAuthorizationUrl,
  callbackParams: (req) => ({ ...req.query }),
  callback: jest.fn(async () => ({ access_token: 'idp-access' })),
  userinfo: mockOidcUserinfo,
};
const mockOidcClientConstructor = jest.fn(function MockOidcClient() {
  return mockOidcClient;
});
const mockOidcDiscover = jest.fn(async () => ({ Client: mockOidcClientConstructor }));

jest.mock('openid-client', () => ({
  generators: {
    state: () => 'generated-state',
    nonce: () => 'generated-nonce',
  },
  Issuer: { discover: mockOidcDiscover },
}));

// The OIDC issuer is DNS-checked against private ranges (SSRF guard). Tests
// never resolve real hostnames; individual tests make it reject.
const mockAssertSafeOutboundUrl = jest.fn(async (url) => url);
jest.mock('../src/utils/safeOutboundUrl', () => ({
  ...jest.requireActual('../src/utils/safeOutboundUrl'),
  assertSafeOutboundUrl: (...args) => mockAssertSafeOutboundUrl(...args),
}));

jest.mock('../src/config/database', () => ({
  query:         mockQuery,
  execute:       jest.fn(),
  getConnection: mockGetConn,
  close:         jest.fn(),
  pool:          { end: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock auth + org middleware
// ---------------------------------------------------------------------------
// Test headers let a case act as another org, an API token or a global
// identity. Default: an org-1 admin with a browser session.
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = {
      id: 1,
      email: 'admin@test.com',
      role: 'admin',
      organizationId: Number(req.headers['x-test-org'] || 1),
    };
    if (req.headers['x-test-api-token']) req.user.apiTokenId = 9;
    if (req.headers['x-test-global']) req.user.hasGlobalOrganizationAccess = true;
    next();
  },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = req.user.organizationId; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole:       () => (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/ipAllowlist', () => ({
  ...jest.requireActual('../src/middleware/ipAllowlist'),
  createIpAllowlist: () => (_req, _res, next) => next(),
  parseAllowlist:    () => [],
}));
jest.mock('../src/middleware/adminIpAllowlist', () => ({
  enforceAdminIpAllowlist: (_req, _res, next) => next(),
}));

// ---------------------------------------------------------------------------
// Enable SSO feature flag
// ---------------------------------------------------------------------------
jest.mock('../src/config', () => ({
  env:    'test',
  appUrl: 'http://localhost:3000',
  jwt: {
    secret:           'test-secret-that-is-64-chars-long-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    accessExpiresIn:  '15m',
    refreshExpiresIn: '7d',
    algorithm:        'HS256',
  },
  rateLimit:          { windowMs: 900000, api: 200, auth: 20, public: 60, upload: 30, export: 20, sse: 10, webhook: 100, tenantWindowMs: 900000, tenantApi: 500 },
  requestTimeoutMs:   0,
  corsOrigins:        '',
  adminIpAllowlist:   '',
  installOperatorUserIds: [],
  log:                { level: 'silent' },
  features: {
    cfdi: false, radius: false, twoFactor: false, webhooks: false, snmp: false,
    sso: true,
  },
}));

// ---------------------------------------------------------------------------
// Pull in service + app AFTER mocks are in place
// ---------------------------------------------------------------------------
const ssoService = require('../src/services/ssoService');
const request    = require('supertest');
const app        = require('../src/app');

// ============================================================================
// Unit tests — ssoService helpers
// ============================================================================

describe('ssoService.parseAttributeMapping', () => {
  const { parseAttributeMapping } = ssoService;

  test('returns {} for null', () => {
    expect(parseAttributeMapping(null)).toEqual({});
  });

  test('returns the object if already parsed', () => {
    const obj = { email: 'mail' };
    expect(parseAttributeMapping(obj)).toBe(obj);
  });

  test('parses a JSON string', () => {
    expect(parseAttributeMapping('{"email":"mail"}')).toEqual({ email: 'mail' });
  });

  test('returns {} for invalid JSON', () => {
    expect(parseAttributeMapping('not-json')).toEqual({});
  });
});

describe('ssoService.normalizeSamlProfile', () => {
  const { normalizeSamlProfile } = ssoService;

  test('extracts email from standard SAML attribute', () => {
    const profile = {
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'u@example.com',
      groups: ['admins'],
    };
    const r = normalizeSamlProfile(profile, {}, 'groups');
    expect(r.email).toBe('u@example.com');
    expect(r.groups).toEqual(['admins']);
  });

  test('uses mapped attribute names', () => {
    const profile = { customEmail: 'mapped@example.com', customGroups: ['g1', 'g2'] };
    const attrMap = { email: 'customEmail' };
    const r = normalizeSamlProfile(profile, attrMap, 'customGroups');
    expect(r.email).toBe('mapped@example.com');
    expect(r.groups).toEqual(['g1', 'g2']);
  });

  test('wraps single group string in an array', () => {
    const profile = { email: 'a@b.com', groups: 'single-group' };
    const r = normalizeSamlProfile(profile, {}, 'groups');
    expect(r.groups).toEqual(['single-group']);
  });

  test('returns empty groups array when attribute absent', () => {
    const profile = { email: 'a@b.com' };
    const r = normalizeSamlProfile(profile, {}, 'groups');
    expect(r.groups).toEqual([]);
  });
});

describe('ssoService.normalizeOidcProfile', () => {
  const { normalizeOidcProfile } = ssoService;

  test('extracts standard OIDC claims', () => {
    const userinfo = { email: 'u@ex.com', given_name: 'Alice', family_name: 'Smith', groups: ['dev'] };
    const r = normalizeOidcProfile(userinfo, {}, 'groups');
    expect(r.email).toBe('u@ex.com');
    expect(r.firstName).toBe('Alice');
    expect(r.lastName).toBe('Smith');
    expect(r.groups).toEqual(['dev']);
  });

  // SEC-05: preferred_username is a free-form, often user-editable handle and
  // was used as the "email" that linked to existing accounts. It is no longer
  // a fallback (this test previously asserted the insecure fallback).
  test('does not fall back to preferred_username for email', () => {
    const userinfo = { preferred_username: 'admin@demo-isp.com', given_name: 'Alice', family_name: 'Smith' };
    const r = normalizeOidcProfile(userinfo, {}, 'groups');
    expect(r.email).toBe('');
  });

  test('carries the subject and an explicit email_verified=false', () => {
    const r = normalizeOidcProfile({ sub: 'abc', email: 'a@b.com', email_verified: false }, {}, 'groups');
    expect(r.subject).toBe('abc');
    expect(r.emailVerified).toBe(false);
  });

  test('uses attribute mapping overrides', () => {
    const userinfo = { mail: 'mapped@ex.com', fn: 'Bob', ln: 'Jones' };
    const attrMap = { email: 'mail', firstName: 'fn', lastName: 'ln' };
    const r = normalizeOidcProfile(userinfo, attrMap, 'groups');
    expect(r.email).toBe('mapped@ex.com');
    expect(r.firstName).toBe('Bob');
    expect(r.lastName).toBe('Jones');
  });

  test('returns empty groups when no group attribute present', () => {
    const userinfo = { email: 'a@b.com' };
    const r = normalizeOidcProfile(userinfo, {}, 'groups');
    expect(r.groups).toEqual([]);
  });
});

describe('ssoService.normalizeOidcRedirectPath', () => {
  const { normalizeOidcRedirectPath } = ssoService;

  test.each([
    '/dashboard',
    '/clients/42?tab=billing',
    '/sso/complete#section',
  ])('accepts same-application path %s', (path) => {
    expect(normalizeOidcRedirectPath(path)).toBe(path);
  });

  test.each([
    ['absolute URL', 'https://attacker.example/steal'],
    ['protocol-relative URL', '//attacker.example/steal'],
    ['backslash-relative URL', '/\\attacker.example/steal'],
    ['browser-normalized tab bypass', '/\t/attacker.example/steal'],
    ['bare path', 'dashboard'],
    ['empty string', ''],
    ['repeated query parameter', ['/dashboard', 'https://attacker.example']],
    ['missing value', undefined],
  ])('rejects %s', (_label, value) => {
    expect(normalizeOidcRedirectPath(value)).toBeNull();
  });
});

describe('ssoService.generateOidcLoginUrl redirect persistence', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockOidcAuthorizationUrl.mockClear();
  });

  test.each([
    ['/clients/42?tab=billing', '/clients/42?tab=billing'],
    ['https://attacker.example/steal', null],
    ['//attacker.example/steal', null],
  ])('stores %p as %p', async (redirectTo, expectedStoredValue) => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 10, is_enabled: 1, oidc_issuer: 'https://idp.example', oidc_client_id: 'client' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await expect(ssoService.generateOidcLoginUrl(1, redirectTo))
      .resolves.toBe('https://idp.example/authorize');

    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO sso_auth_states'),
      ['generated-state', 'generated-nonce', 1, expectedStoredValue],
    );
  });
});

// ============================================================================
// Unit tests — ssoService.findOrCreateSsoUser
// ============================================================================

describe('ssoService.findOrCreateSsoUser', () => {
  const ORG_ID = 1;
  const CFG_ENABLED = { id: 10, provider_type: 'oidc', is_enabled: 1, auto_provision: 1, default_role: 'readonly' };
  const PROFILE     = {
    email: 'user@example.com', firstName: 'Jane', lastName: 'Doe', groups: ['admins'],
    issuer: 'https://idp.example', subject: 'sub-123', emailVerified: null,
  };
  const MAPPINGS    = [{ idp_group: 'admins', fireisp_role: 'admin' }];

  /**
   * Route db.query by statement. `state` describes the install:
   *   usersByEmail, usersById, links (identity_hash -> user_id), userLinks
   *   (user ids already linked at this org/provider), memberships.
   */
  function routeDb(state) {
    const calls = [];
    mockQuery.mockImplementation(async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT user_id FROM user_sso_identities/.test(sql)) {
        const uid = state.links?.[params[2]] ?? state.linkAfterInsert?.[params[2]];
        return [uid ? [{ user_id: uid }] : []];
      }
      if (/SELECT id FROM user_sso_identities/.test(sql)) {
        return [(state.userLinks || []).includes(params[2]) ? [{ id: 1 }] : []];
      }
      if (/INSERT IGNORE INTO user_sso_identities/.test(sql)) {
        state.linkAfterInsert = { ...(state.linkAfterInsert || {}), [params[4]]: state.linkWinner ?? params[5] };
        return [{ affectedRows: 1 }];
      }
      if (/FROM users WHERE email = \?/.test(sql)) {
        return [state.usersByEmail?.[params[0]] ? [state.usersByEmail[params[0]]] : []];
      }
      if (/SELECT \* FROM users WHERE id = \?/.test(sql)) {
        const u = state.usersById?.[params[0]];
        return [u ? [u] : []];
      }
      if (/INSERT INTO users/.test(sql)) return [{ insertId: 99 }];
      if (/FROM organization_users WHERE user_id = \?/.test(sql)) return [state.memberships || []];
      if (/FROM users u\s+JOIN roles r/.test(sql)) return [state.groupRows || []];
      if (/is_install_operator FROM users/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    });
    return calls;
  }

  const homed = (over = {}) => ({
    id: 5, email: 'user@example.com', role: 'support', status: 'active',
    organization_id: ORG_ID, is_install_operator: 0, ...over,
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  test('links an eligible account homed in the SSO org and maps its role', async () => {
    const calls = routeDb({
      usersByEmail: { 'user@example.com': homed() },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });

    const { user, orgRole } = await ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS);
    expect(user.id).toBe(5);
    expect(orgRole).toBe('admin');

    const link = calls.find(c => /INSERT IGNORE INTO user_sso_identities/.test(c.sql));
    expect(link.params).toEqual([ORG_ID, 'oidc', 'https://idp.example', 'sub-123', expect.stringMatching(/^[0-9a-f]{64}$/), 5]);
    const membership = calls.find(c => /INSERT INTO organization_users/.test(c.sql));
    expect(membership.sql).not.toMatch(/deleted_at/);
    const group = calls.find(c => /UPDATE users u/.test(c.sql));
    expect(group.sql).toMatch(/u\.organization_id = \?/);
    expect(group.params).toEqual(['admin', 5, ORG_ID]);
  });

  test('uses default_role when no group matches', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed() },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    const noMatchMappings = [{ idp_group: 'other-group', fireisp_role: 'manager' }];
    const { orgRole } = await ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, noMatchMappings);
    expect(orgRole).toBe('readonly');
  });

  test('ignores a stored mapping whose role is outside the SSO role set', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed() },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    const { orgRole } = await ssoService.findOrCreateSsoUser(
      ORG_ID, PROFILE, CFG_ENABLED, [{ idp_group: 'admins', fireisp_role: 'super_admin' }],
    );
    expect(orgRole).toBe('readonly');
  });

  test('auto-provisions a new user homed in the org when the email is unused install-wide', async () => {
    const created = homed({ id: 99, password_hash: 'x' });
    const calls = routeDb({ usersById: { 99: created }, memberships: [] });

    const { user, orgRole } = await ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS);
    expect(user.id).toBe(99);
    expect(orgRole).toBe('admin');
    const insert = calls.find(c => /INSERT INTO users/.test(c.sql));
    expect(insert.params[0]).toBe(ORG_ID);
    expect(calls.some(c => /INSERT IGNORE INTO user_sso_identities/.test(c.sql))).toBe(true);
  });

  test('throws UnauthorizedError when auto_provision=false and user not found', async () => {
    routeDb({});
    const cfgNoProvision = { ...CFG_ENABLED, auto_provision: 0 };
    await expect(
      ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, cfgNoProvision, []),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test('throws UnauthorizedError when profile has no email', async () => {
    const badProfile = { ...PROFILE, email: '' };
    await expect(
      ssoService.findOrCreateSsoUser(ORG_ID, badProfile, CFG_ENABLED, []),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  // ---- SEC-05 regressions: the IdP-asserted email used to match ANY account
  // ---- on the install, and the minted session was that account's.

  test('refuses an account homed in another organization (no link, no membership)', async () => {
    const calls = routeDb({
      usersByEmail: { 'user@example.com': homed({ organization_id: 2 }) },
      memberships: [{ organization_id: 2, deleted_at: null }],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(calls.some(c => /INSERT INTO organization_users/.test(c.sql))).toBe(false);
    expect(calls.some(c => /INSERT IGNORE INTO user_sso_identities/.test(c.sql))).toBe(false);
    expect(calls.some(c => /UPDATE users u/.test(c.sql))).toBe(false);
  });

  test('refuses the install operator even when homed in the SSO org', async () => {
    const calls = routeDb({
      usersByEmail: { 'user@example.com': homed({ role: 'admin', is_install_operator: 1 }) },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(calls.some(c => /INSERT INTO organization_users/.test(c.sql))).toBe(false);
  });

  test('refuses a system super_admin', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed({ role: 'admin' }) },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
      groupRows: [{ group_name: 'super_admin', group_is_system: 1 }],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses an account that also holds a live membership in another org', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed() },
      memberships: [
        { organization_id: ORG_ID, deleted_at: null },
        { organization_id: 3, deleted_at: null },
      ],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('does not resurrect a removed membership', async () => {
    const calls = routeDb({
      usersByEmail: { 'user@example.com': homed({ organization_id: null }) },
      memberships: [{ organization_id: ORG_ID, deleted_at: new Date() }],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(calls.some(c => /INSERT INTO organization_users/.test(c.sql))).toBe(false);
  });

  test('a member-only account (no home org) is linked but its global group is left alone', async () => {
    const calls = routeDb({
      usersByEmail: { 'user@example.com': homed({ organization_id: null }) },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    await ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS);
    expect(calls.some(c => /UPDATE users u/.test(c.sql))).toBe(false);
  });

  test('a linked identity decides the account, not the asserted email', async () => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('https://idp.example\nsub-123').digest('hex');
    const calls = routeDb({
      links: { [hash]: 5 },
      usersById: { 5: homed() },
      usersByEmail: { 'user@example.com': homed({ id: 6 }) },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    const { user } = await ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS);
    expect(user.id).toBe(5);
    expect(calls.some(c => /FROM users WHERE email = \?/.test(c.sql))).toBe(false);
    // Lookups are always bound to the SSO organization.
    const lookup = calls.find(c => /SELECT user_id FROM user_sso_identities/.test(c.sql));
    expect(lookup.params[0]).toBe(ORG_ID);
  });

  test('refuses an email match for an account already linked to a different IdP identity', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed() },
      userLinks: [5],
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses when a concurrent sign-in linked the identity to another account', async () => {
    routeDb({
      usersByEmail: { 'user@example.com': homed() },
      memberships: [{ organization_id: ORG_ID, deleted_at: null }],
      linkWinner: 77,
    });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, PROFILE, CFG_ENABLED, MAPPINGS))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('refuses an email the IdP marks as unverified', async () => {
    routeDb({ usersByEmail: { 'user@example.com': homed() } });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, { ...PROFILE, emailVerified: false }, CFG_ENABLED, []))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('refuses a profile without a stable subject', async () => {
    routeDb({ usersByEmail: { 'user@example.com': homed() } });
    await expect(ssoService.findOrCreateSsoUser(ORG_ID, { ...PROFILE, subject: '' }, CFG_ENABLED, []))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});

// ============================================================================
// Unit tests — ssoService.mintTokens
// ============================================================================

describe('ssoService.mintTokens', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns accessToken, refreshToken, expiresIn, user, organizations', async () => {
    const user = { id: 1, email: 'a@b.com', role: 'admin', status: 'active' };
    // INSERT session
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
    // UPDATE last_login_at
    mockQuery.mockResolvedValueOnce([{}]);
    // SELECT organizations
    mockQuery.mockResolvedValueOnce([[{ id: 1, name: 'Acme', membership_role: 'admin' }]]);

    const result = await ssoService.mintTokens(user, 1);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toHaveLength(64); // 32 bytes hex
    expect(result.expiresIn).toBeGreaterThan(0);
    expect(result.user).not.toHaveProperty('password_hash');
    expect(result.organizations).toHaveLength(1);
  });
});

// ============================================================================
// Unit tests — ssoService.getConfig / saveConfig
// ============================================================================

describe('ssoService.getConfig', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns null when no config exists', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // empty result
    const cfg = await ssoService.getConfig(1, 'saml');
    expect(cfg).toBeNull();
  });

  test('returns row when config exists', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 1, organization_id: 1, provider_type: 'saml', is_enabled: 1 }]]);
    const cfg = await ssoService.getConfig(1, 'saml');
    expect(cfg.id).toBe(1);
  });
});

describe('ssoService.saveConfig', () => {
  beforeEach(() => mockQuery.mockReset());

  test('creates a new config row when none exists', async () => {
    // existing check → not found
    mockQuery.mockResolvedValueOnce([[]]); // SELECT id
    // INSERT
    mockQuery.mockResolvedValueOnce([{ insertId: 5 }]);
    // getConfig after save
    mockQuery.mockResolvedValueOnce([[{ id: 5, organization_id: 1, provider_type: 'saml', is_enabled: 1 }]]);

    const result = await ssoService.saveConfig(1, 'saml', { is_enabled: true });
    expect(result.id).toBe(5);
  });

  test('updates an existing config row', async () => {
    // existing check → found
    mockQuery.mockResolvedValueOnce([[{ id: 3 }]]);
    // UPDATE
    mockQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
    // getConfig after save
    mockQuery.mockResolvedValueOnce([[{ id: 3, organization_id: 1, provider_type: 'oidc', is_enabled: 0 }]]);

    const result = await ssoService.saveConfig(1, 'oidc', { is_enabled: false });
    expect(result.id).toBe(3);
  });
});

// ============================================================================
// Unit tests — ssoService.getGroupMappings / saveGroupMappings
// ============================================================================

describe('ssoService.getGroupMappings', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns sorted mappings for a config', async () => {
    const rows = [
      { id: 1, idp_group: 'admins', fireisp_role: 'admin' },
      { id: 2, idp_group: 'staff',  fireisp_role: 'technician' },
    ];
    mockQuery.mockResolvedValueOnce([rows]);
    const result = await ssoService.getGroupMappings(10);
    expect(result).toHaveLength(2);
    expect(result[0].idp_group).toBe('admins');
  });
});

describe('ssoService.saveGroupMappings', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockConnBegin.mockReset().mockResolvedValue(undefined);
    mockConnCommit.mockReset().mockResolvedValue(undefined);
    mockConnRollback.mockReset().mockResolvedValue(undefined);
    mockGetConn.mockResolvedValue({
      query:            mockConnQuery,
      beginTransaction: mockConnBegin,
      commit:           mockConnCommit,
      rollback:         mockConnRollback,
      release:          mockConnRelease,
    });
    mockConnQuery.mockReset().mockResolvedValue([{}]);
  });

  test('replaces all mappings in a transaction', async () => {
    // After save, getGroupMappings query
    mockQuery.mockResolvedValueOnce([[{ id: 1, idp_group: 'g1', fireisp_role: 'admin' }]]);

    const mappings = [{ idp_group: 'g1', fireisp_role: 'admin' }];
    const result = await ssoService.saveGroupMappings(10, mappings);
    expect(mockConnBegin).toHaveBeenCalled();
    expect(mockConnCommit).toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  test('rolls back on error', async () => {
    mockConnQuery
      .mockResolvedValueOnce([{}])  // DELETE
      .mockRejectedValueOnce(new Error('DB error')); // INSERT fails

    await expect(ssoService.saveGroupMappings(10, [{ idp_group: 'g', fireisp_role: 'admin' }]))
      .rejects.toThrow('DB error');
    expect(mockConnRollback).toHaveBeenCalled();
  });
});

// ============================================================================
// Unit tests — ssoService.purgeExpiredStates
// ============================================================================

describe('ssoService.purgeExpiredStates', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns number of deleted rows', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 3 }]);
    const n = await ssoService.purgeExpiredStates();
    expect(n).toBe(3);
  });

  test('returns 0 when no expired rows', async () => {
    mockQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const n = await ssoService.purgeExpiredStates();
    expect(n).toBe(0);
  });
});

// ============================================================================
// Integration tests — SSO routes via supertest
// ============================================================================

describe('SSO routes — feature disabled returns 404', () => {
  let savedFeature;

  beforeAll(() => {
    savedFeature = require('../src/config').features.sso;
    require('../src/config').features.sso = false;
  });

  afterAll(() => {
    require('../src/config').features.sso = savedFeature;
  });

  test('GET /api/v1/sso/1/saml/config returns 404 when SSO disabled', async () => {
    const res = await request(app).get('/api/v1/sso/1/saml/config');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
  });
});

describe('GET /api/v1/sso/:orgId/saml/config', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns 404 when no SAML config exists', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // getConfig → not found
    const res = await request(app).get('/api/v1/sso/1/saml/config');
    expect(res.status).toBe(404);
  });

  test('returns config without private key fields', async () => {
    mockQuery.mockResolvedValueOnce([[{
      id: 1, organization_id: 1, provider_type: 'saml', is_enabled: 1,
      saml_entity_id: 'urn:example', saml_sp_private_key: 'secret-key', oidc_client_secret: null,
    }]]);
    const res = await request(app).get('/api/v1/sso/1/saml/config');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('saml_sp_private_key');
    expect(res.body.data).not.toHaveProperty('oidc_client_secret');
  });
});

describe('PUT /api/v1/sso/:orgId/saml/config', () => {
  beforeEach(() => mockQuery.mockReset());

  test('creates SAML config and returns 200', async () => {
    // saveConfig: existing check → not found → INSERT → getConfig
    mockQuery
      .mockResolvedValueOnce([[]])                    // SELECT id (not found)
      .mockResolvedValueOnce([{ insertId: 7 }])       // INSERT
      .mockResolvedValueOnce([[{ id: 7, organization_id: 1, provider_type: 'saml', is_enabled: 1 }]]); // getConfig

    const res = await request(app)
      .put('/api/v1/sso/1/saml/config')
      .send({ is_enabled: true, saml_sso_url: 'https://idp.example.com/sso' });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(7);
  });
});

describe('GET /api/v1/sso/:orgId/saml/group-mappings', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns 404 when SAML config not found', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // getConfig → not found
    const res = await request(app).get('/api/v1/sso/1/saml/group-mappings');
    expect(res.status).toBe(404);
  });

  test('returns group mappings list', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, provider_type: 'saml' }]]) // getConfig
      .mockResolvedValueOnce([[{ id: 1, idp_group: 'admins', fireisp_role: 'admin' }]]); // getGroupMappings
    const res = await request(app).get('/api/v1/sso/1/saml/group-mappings');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].idp_group).toBe('admins');
  });
});

describe('PUT /api/v1/sso/:orgId/saml/group-mappings', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetConn.mockReset();
    mockConnQuery.mockReset();
    mockGetConn.mockResolvedValue({
      query: mockConnQuery,
      beginTransaction: mockConnBegin,
      commit: mockConnCommit,
      rollback: mockConnRollback,
      release: mockConnRelease,
    });
    mockConnQuery.mockResolvedValue([{}]);
  });

  test('replaces group mappings and returns 200', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, provider_type: 'saml' }]]) // getConfig
      .mockResolvedValueOnce([[{ id: 1, idp_group: 'admins', fireisp_role: 'admin' }]]); // getGroupMappings after save

    const res = await request(app)
      .put('/api/v1/sso/1/saml/group-mappings')
      .send({ mappings: [{ idp_group: 'admins', fireisp_role: 'admin' }] });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('GET /api/v1/sso/:orgId/oidc/config', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns 404 when no OIDC config exists', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // getConfig → not found
    const res = await request(app).get('/api/v1/sso/1/oidc/config');
    expect(res.status).toBe(404);
  });

  test('returns OIDC config without client_secret', async () => {
    mockQuery.mockResolvedValueOnce([[{
      id: 2, organization_id: 1, provider_type: 'oidc', is_enabled: 1,
      oidc_issuer: 'https://accounts.example.com', oidc_client_id: 'client-id',
      oidc_client_secret: 'encrypted-secret', saml_sp_private_key: null,
    }]]);
    const res = await request(app).get('/api/v1/sso/1/oidc/config');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('oidc_client_secret');
    expect(res.body.data.oidc_issuer).toBe('https://accounts.example.com');
  });
});

describe('GET /api/v1/sso/0/saml/config — invalid orgId', () => {
  test('returns 400 for orgId=0', async () => {
    const res = await request(app).get('/api/v1/sso/0/saml/config');
    expect(res.status).toBe(400);
  });
});

describe('SSO saml/login — feature enabled, config missing', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns 403 when SAML config not found', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // getConfig → not found
    const res = await request(app).get('/api/v1/sso/1/saml/login');
    // ForbiddenError (cfg not found / not enabled) → 403
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// SEC-04 — admin endpoints are bound to the caller's active organization
// ============================================================================

describe('SSO admin endpoints — :orgId must be the caller org', () => {
  const ROUTES = [
    ['get', '/api/v1/sso/2/saml/config'],
    ['put', '/api/v1/sso/2/saml/config'],
    ['get', '/api/v1/sso/2/oidc/config'],
    ['put', '/api/v1/sso/2/oidc/config'],
    ['get', '/api/v1/sso/2/saml/group-mappings'],
    ['put', '/api/v1/sso/2/saml/group-mappings'],
    ['get', '/api/v1/sso/2/oidc/group-mappings'],
    ['put', '/api/v1/sso/2/oidc/group-mappings'],
  ];

  beforeEach(() => mockQuery.mockReset());

  test.each(ROUTES)('an org-1 admin gets 403 on %s %s and nothing is read or written', async (method, path) => {
    const res = await request(app)[method](path).send({ mappings: [], is_enabled: true });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('an API token gets 403 on %s %s even for its own org', async (method, path) => {
    const res = await request(app)[method](path.replace('/sso/2/', '/sso/1/'))
      .set('x-test-api-token', '1')
      .send({ mappings: [], is_enabled: true });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an org-2 admin may read org 2', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 4, organization_id: 2, provider_type: 'oidc', is_enabled: 1 }]]);
    const res = await request(app).get('/api/v1/sso/2/oidc/config').set('x-test-org', '2');
    expect(res.status).toBe(200);
    expect(mockQuery.mock.calls[0][1]).toEqual([2, 'oidc']);
  });

  test('an installation-global browser identity may administer another org', async () => {
    mockQuery.mockResolvedValueOnce([[{ id: 4, organization_id: 2, provider_type: 'oidc', is_enabled: 1 }]]);
    const res = await request(app).get('/api/v1/sso/2/oidc/config').set('x-test-global', '1');
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// SEC-05 — config and mapping validation
// ============================================================================

describe('SSO config/mapping validation', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetConn.mockClear();
    mockAssertSafeOutboundUrl.mockReset().mockImplementation(async (url) => url);
  });

  test('PUT oidc/config rejects an issuer that resolves to a private address', async () => {
    const { AppError } = require('../src/utils/errors');
    mockAssertSafeOutboundUrl.mockRejectedValueOnce(
      new AppError('oidc_issuer must not target a private or loopback host.', 422, 'UNSAFE_URL'),
    );
    const res = await request(app)
      .put('/api/v1/sso/1/oidc/config')
      .send({ oidc_issuer: 'https://169.254.169.254/latest' });
    expect(res.status).toBe(422);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('PUT saml/config rejects a non-https SSO URL', async () => {
    const res = await request(app)
      .put('/api/v1/sso/1/saml/config')
      .send({ saml_sso_url: 'http://idp.example.com/sso' });
    expect(res.status).toBe(422);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each([
    [[{ idp_group: 'admins', fireisp_role: 'super_admin' }]],
    [[{ idp_group: 'admins', fireisp_role: 'owner' }]],
    [[{ idp_group: '', fireisp_role: 'admin' }]],
    [['admins']],
  ])('PUT group-mappings rejects %j', async (mappings) => {
    mockQuery.mockResolvedValueOnce([[{ id: 1, organization_id: 1, provider_type: 'saml' }]]); // getConfig
    const res = await request(app).put('/api/v1/sso/1/saml/group-mappings').send({ mappings });
    expect(res.status).toBe(422);
    expect(mockGetConn).not.toHaveBeenCalled();
  });

  test('OIDC discovery re-checks the issuer before any outbound request', async () => {
    const { AppError } = require('../src/utils/errors');
    mockOidcDiscover.mockClear();
    mockAssertSafeOutboundUrl.mockRejectedValueOnce(new AppError('unsafe', 422, 'UNSAFE_URL'));
    mockQuery
      .mockResolvedValueOnce([[{ id: 10, is_enabled: 1, oidc_issuer: 'https://rebound.example', oidc_client_id: 'c' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(ssoService.generateOidcLoginUrl(1, '/')).rejects.toMatchObject({ statusCode: 422 });
    expect(mockOidcDiscover).not.toHaveBeenCalled();
  });
});

// ============================================================================
// SEC-03 — SSO honours TOTP two-factor
// ============================================================================

describe('GET /sso/:orgId/oidc/callback — 2FA', () => {
  const ISSUER = 'https://idp-2fa.example';

  function routeCallbackDb(user) {
    mockQuery.mockImplementation(async (sql) => {
      if (/FROM organization_sso_configs/.test(sql)) {
        return [[{ id: 10, organization_id: 1, provider_type: 'oidc', is_enabled: 1, auto_provision: 0,
          default_role: 'readonly', oidc_issuer: ISSUER, oidc_client_id: 'c' }]];
      }
      if (/FROM sso_auth_states/.test(sql)) return [[{ state: 's1', nonce: 'n1', organization_id: 1, redirect_to: null }]];
      if (/FROM organization_sso_group_mappings/.test(sql)) return [[]];
      if (/SELECT user_id FROM user_sso_identities/.test(sql)) return [[{ user_id: user.id }]];
      if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return [[user]];
      if (/FROM organization_users WHERE user_id = \?/.test(sql)) return [[{ organization_id: 1, deleted_at: null }]];
      return [{ affectedRows: 1 }];
    });
  }

  beforeEach(() => {
    mockQuery.mockReset();
    mockOidcUserinfo.mockReset().mockResolvedValue({ sub: 'sub-1', email: 'tech@example.com' });
    mockAssertSafeOutboundUrl.mockReset().mockImplementation(async (url) => url);
  });

  test('a TOTP-enabled account gets a challenge redirect, not tokens', async () => {
    routeCallbackDb({ id: 5, email: 'tech@example.com', role: 'technician', status: 'active',
      organization_id: 1, is_install_operator: 0, totp_enabled: 1, password_hash: 'h' });

    const res = await request(app).get('/api/v1/sso/1/oidc/callback?state=s1&code=c1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:3000\/login#mfa_token=/);
    expect(res.headers.location).not.toMatch(/accessToken|refreshToken/);
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO user_sessions/.test(sql))).toBe(false);

    const { verifyMfaChallengeToken } = require('../src/utils/accessTokens');
    const token = decodeURIComponent(res.headers.location.split('#mfa_token=')[1]);
    expect(verifyMfaChallengeToken(token)).toMatchObject({ sub: 5, method: 'sso', orgId: 1 });
  });

  test('an account without 2FA still receives tokens', async () => {
    routeCallbackDb({ id: 5, email: 'tech@example.com', role: 'technician', status: 'active',
      organization_id: 1, is_install_operator: 0, totp_enabled: 0, password_hash: 'h' });

    const res = await request(app).get('/api/v1/sso/1/oidc/callback?state=s1&code=c1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/sso\/callback#accessToken=/);
    expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO user_sessions/.test(sql))).toBe(true);
  });
});
