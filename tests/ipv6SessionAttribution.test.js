// =============================================================================
// REG-08 — IPv6 accounting is recorded and searchable by containment
// =============================================================================
// Both ingest paths read only Framed-IPv6-Prefix, so Delegated-IPv6-Prefix and
// Framed-IPv6-Address never reached connection_logs, and the session search
// compared IPv6 by exact string. An authority asking about an address on a dual-
// stack subscriber's delegated /56 found nothing.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(),
  close: jest.fn(), pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const { containingIpv6Prefixes } = require('../src/utils/ipAddress');
const { normalizeAccountingBody } = require('../src/routes/radiusAccounting');
const codec = require('../src/services/radiusServerCodec');

beforeEach(() => jest.clearAllMocks());

test('the prefixes that contain an address, canonical', () => {
  const list = containingIpv6Prefixes('2806:2F0:1234:5600::ABCD');
  expect(list).toHaveLength(129);
  expect(list).toContain('2806:2f0:1234:5600::/56');
  expect(list).toContain('2806:2f0::/32');
  expect(list[128]).toBe('2806:2f0:1234:5600::abcd/128');
});

test('the REST ingest reads Delegated-IPv6-Prefix and Framed-IPv6-Address', () => {
  const attrs = normalizeAccountingBody({
    'Acct-Status-Type': 'Start', 'User-Name': 'u', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.1',
    'Delegated-IPv6-Prefix': '2806:2f0:1234:5600::/56', 'Framed-IPv6-Address': '2806:2f0::1',
  });
  expect(attrs).toMatchObject({ delegatedIpv6Prefix: '2806:2f0:1234:5600::/56', framedIpv6Address: '2806:2f0::1' });
});

test('the embedded listener decodes both attributes', () => {
  const pd = codec.encodeIpv6PrefixAttr(codec.ATTR.DELEGATED_IPV6_PREFIX, '2806:2f0:1234:5600::', 56);
  const wan = codec.encodeIpv6AddressAttr(codec.ATTR.FRAMED_IPV6_ADDRESS, '2806:2f0::1');
  const attributes = [{ type: pd[0], value: pd.subarray(2) }, { type: wan[0], value: wan.subarray(2) }];
  expect(codec.getIpv6Prefix(attributes, codec.ATTR.DELEGATED_IPV6_PREFIX)).toBe('2806:2f0:1234:5600::/56');
  expect(codec.getIpv6Address(attributes)).toBe('2806:2f0::1');
});

test('GET /connection-logs?ip_address=<LAN address> matches the delegated prefix', async () => {
  db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  const app = require('../src/app');
  const res = await request(app).get('/api/v1/connection-logs').query({ ip_address: '2806:2f0:1234:5600::abcd' });
  expect(res.status).toBe(200);
  const [sql, params] = db.query.mock.calls.find(([q]) => /FROM connection_logs cl/.test(q));
  expect(sql).toMatch(/cl\.ipv6_delegated_prefix IN \(\?/);
  expect(params).toContain('2806:2f0:1234:5600::/56');
  expect(params).toContain('2806:2f0:1234:5600::abcd');
});
