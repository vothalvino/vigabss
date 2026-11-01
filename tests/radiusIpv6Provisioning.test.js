// =============================================================================
// NET-17 — a dual-stack account's IPv6 reaches the NAS
// =============================================================================
// pppoe_dual provisioning sets radius.ipv6_pool_id, but the embedded server's
// Access-Accept carried no IPv6 attribute, and syncFreeradiusTables emitted
// Delegated-IPv6-Prefix-Pool only through a PPPoE profile with ipv6cp_enabled,
// which pppoe_dual does not imply. Static ipv6_address / ipv6_delegated_prefix
// were never sent by either path, so dual-stack subscribers came up IPv4-only.
// =============================================================================

const crypto = require('crypto');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/radiusAccountingService', () => ({ ingestAccounting: jest.fn() }));

const db = require('../src/config/database');
const codec = require('../src/services/radiusServerCodec');
const coa = require('../src/services/radiusCoaEncoder');
const radiusService = require('../src/services/radiusService');
const svc = require('../src/services/radiusServerService');

const SECRET = 'testing123';
const DUAL = {
  ipv6_address: '2806:2f0::abcd', ipv6_delegated_prefix: '2806:2f0:1234:5600::/56', ipv6_prefix_len: 56,
  ipv6_pool_name: 'pd-pool',
};

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('embedded server Access-Accept', () => {
  function papRequest() {
    const reqAuth = crypto.randomBytes(16);
    const attrs = coa.encodeAttributes([
      coa.encodeUserName('bob'),
      { type: codec.ATTR.USER_PASSWORD, value: codec.encodePapPassword('s3cret', SECRET, reqAuth) },
    ]);
    return coa.buildRadiusPacket(codec.CODE.ACCESS_REQUEST, 7, reqAuth, attrs);
  }

  test('carries Framed-IPv6-Address, Delegated-IPv6-Prefix and the PD pool', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM nas/.test(sql)) return [[{ id: 3, organization_id: 1, secret: SECRET, require_message_authenticator: 0 }]];
      if (/FROM radius r/.test(sql)) return [[{ id: 6, username: 'bob', password: 's3cret', ip_address: null, plan_id: null, contract_status: 'active', ...DUAL }]];
      return [[]];
    });
    const respond = jest.fn();
    await svc.handleAuth(papRequest(), { address: '10.0.0.1', port: 5000 }, respond);
    const reply = codec.decodePacket(respond.mock.calls[0][0]);
    expect(reply.code).toBe(codec.CODE.ACCESS_ACCEPT);
    expect(codec.getIpv6Address(reply.attributes)).toBe('2806:2f0::abcd');
    expect(codec.getIpv6Prefix(reply.attributes, codec.ATTR.DELEGATED_IPV6_PREFIX)).toBe('2806:2f0:1234:5600::/56');
    expect(codec.getString(reply.attributes, codec.ATTR.DELEGATED_IPV6_PREFIX_POOL)).toBe('pd-pool');
    const lookup = db.query.mock.calls.find(([sql]) => /FROM radius r/.test(sql))[0];
    expect(lookup).toMatch(/LEFT JOIN ip_pools ipv6_pool ON ipv6_pool\.id = r\.ipv6_pool_id/);
  });

  test('an IPv4-only account gets no IPv6 attribute', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM nas/.test(sql)) return [[{ id: 3, organization_id: 1, secret: SECRET, require_message_authenticator: 0 }]];
      if (/FROM radius r/.test(sql)) return [[{ id: 6, username: 'bob', password: 's3cret', ip_address: '203.0.113.7', plan_id: null, contract_status: 'active' }]];
      return [[]];
    });
    const respond = jest.fn();
    await svc.handleAuth(papRequest(), { address: '10.0.0.1', port: 5000 }, respond);
    const types = codec.decodePacket(respond.mock.calls[0][0]).attributes.map((a) => a.type);
    expect(types).not.toEqual(expect.arrayContaining([codec.ATTR.FRAMED_IPV6_ADDRESS]));
    expect(types).not.toEqual(expect.arrayContaining([codec.ATTR.DELEGATED_IPV6_PREFIX_POOL]));
  });
});

describe('syncFreeradiusTables', () => {
  const SUB = { id: 1, username: 'pppoe-1', cleartext_password: 'pw', auth_method: 'pppoe', organization_id: 1, contract_status: 'active', plan_id: null };
  function route({ subscriber, profiles = [] }) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM radius r\s+LEFT JOIN contracts c ON c.id = r.contract_id\s+LEFT JOIN plans p/.test(sql)) return [[subscriber]];
      if (/FROM pppoe_service_profiles/.test(sql)) return [profiles];
      return [[]];
    });
  }
  const replies = (attribute) => db.query.mock.calls
    .filter(([sql, p]) => /^INSERT INTO radreply/.test(sql) && p[1] === attribute)
    .map(([, p]) => p[3]);

  test('a dual-stack account with no profile gets its IPv6 attributes', async () => {
    route({ subscriber: { ...SUB, ...DUAL } });
    await radiusService.syncFreeradiusTables(1);
    expect(replies('Framed-IPv6-Address')).toEqual(['2806:2f0::abcd']);
    expect(replies('Delegated-IPv6-Prefix')).toEqual(['2806:2f0:1234:5600::/56']);
    expect(replies('Delegated-IPv6-Prefix-Pool')).toEqual(['pd-pool']);
  });

  test('a profile that turns IPv6CP off still suppresses the PD pool', async () => {
    route({
      subscriber: { ...SUB, ipv6_pool_name: 'pd-pool', account_profile_id: 9 },
      profiles: [{ id: 9, ipv6cp_enabled: 0 }],
    });
    await radiusService.syncFreeradiusTables(1);
    expect(replies('Delegated-IPv6-Prefix-Pool')).toEqual([]);
  });

  test('a delegated prefix stored without its length takes ipv6_prefix_len', async () => {
    route({ subscriber: { ...SUB, ipv6_delegated_prefix: '2806:2f0:1234:5600::', ipv6_prefix_len: 56 } });
    await radiusService.syncFreeradiusTables(1);
    expect(replies('Delegated-IPv6-Prefix')).toEqual(['2806:2f0:1234:5600::/56']);
  });
});
