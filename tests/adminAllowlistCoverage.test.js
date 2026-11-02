// =============================================================================
// SEC-26 — credential-minting and integration-config mounts sit behind the
// admin IP allowlist, and the allowlist understands IPv6
// =============================================================================
// The allowlist covered 16 mounts; API tokens, payment gateways, webhooks,
// integrations, router drivers, network security, FireRelay and SSO
// configuration were reachable from any address, and native IPv6 entries
// could not be parsed at all.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 42 }; next(); },
}));

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const { parseEntry, isAllowed } = require('../src/middleware/ipAllowlist');

describe('IPv6 entries', () => {
  test('addresses and CIDR blocks parse and match', () => {
    const list = ['2001:db8::/32', '::1', '10.0.0.0/8'].map(parseEntry);
    expect(list.every(Boolean)).toBe(true);
    expect(isAllowed('2001:db8:1::5', list)).toBe(true);
    expect(isAllowed('2001:db9::5', list)).toBe(false);
    expect(isAllowed('::1', list)).toBe(true);
    expect(isAllowed('::ffff:10.1.2.3', list)).toBe(true);
    expect(parseEntry('2001:db8::/129')).toBeNull();
  });
});

describe('newly gated mounts refuse an address outside the active allowlist', () => {
  beforeEach(() => {
    db.query.mockImplementation(async (sql) => (/FROM admin_ip_allowlist/.test(sql)
      ? [[{ id: 1, organization_id: 42, cidr: '2001:db8::/32', is_active: 1 }]]
      : [[]]));
  });

  test.each([
    '/api/v1/api-tokens',
    '/api/v1/payment-gateways',
    '/api/v1/network-security/firewall-rules',
    '/api/v1/router-drivers',
    '/api/v1/integrations',
  ])('GET %s is 403', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/admin endpoint/);
  });
});

test('FireRelay commands and SSO configuration use the allowlist; their unauthenticated paths do not', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
  const relay = read('firerelay.js');
  expect(relay.indexOf('router.use(enforceAdminIpAllowlist)')).toBeGreaterThan(relay.indexOf("router.get('/health'"));
  expect(read('sso.js')).toMatch(/const adminGuard = \[[^\]]*enforceAdminIpAllowlist\]/);
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  for (const mount of ['webhooks', 'webhook-security']) {
    expect(appSrc).toMatch(new RegExp(`v1\\.use\\('/${mount}', requireFeature\\('webhooks'\\), \\.\\.\\.adminIpAllowlist`));
  }
});
