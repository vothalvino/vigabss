'use strict';
// =============================================================================
// NET-08 — WireGuard routed subnets are validated and cannot overlap
// =============================================================================
// PUT /nas/:id/wg/routes accepted any array, compared other tunnels' subnets
// by exact string only, merely warned (naming the other tenant's tunnel and
// NAS ids), then ran `wg set ... allowed-ips` and `ip route replace` on the
// shared hub. A tenant could route another tenant's LAN (or a more specific
// prefix of it, or 0.0.0.0/0) into its own tunnel.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/wireguardServerService', () => ({
  syncPeer: jest.fn().mockResolvedValue({ applied: true }),
}));
jest.mock('../src/services/userTunnelService', () => ({
  refreshAffectedByNas: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/config/database');
const config = require('../src/config');
const wg = require('../src/services/wireguardServerService');
const { confirmRoutes, normalizeRoutedSubnets } = require('../src/services/wgProvisioningService');

const OWN = { id: 1, nas_id: 7, tunnel_address: '10.255.0.2', nas_public_key: 'pk', routed_subnets: '[]' };
let conn;

function wire(others) {
  conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
    query: jest.fn(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return [[OWN, ...others]];
      return [{ affectedRows: 1 }];
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  db.query.mockImplementation(async (sql) => {
    if (/FROM nas_wg_tunnels WHERE nas_id = \?/.test(sql)) return [[{ ...OWN }]];
    return [{ affectedRows: 1 }];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  config.wireguard.serverSubnet = '10.255.0.0/16';
});

describe('normalizeRoutedSubnets', () => {
  test.each([
    [['192.168.88.0/24'], ['192.168.88.0/24']],
    [[' 10.20.0.0/16 '], ['10.20.0.0/16']],
    [[], []],
  ])('%j is accepted', (input, expected) => {
    expect(normalizeRoutedSubnets(input)).toEqual(expected);
  });

  test.each([
    ['not an array', 'x'],
    ['a non-CIDR string', ['192.168.88.0']],
    ['host bits set', ['192.168.88.1/24']],
    ['an octet over 255', ['300.1.1.0/24']],
    ['a default route', ['0.0.0.0/0']],
    ['a prefix wider than /8', ['10.0.0.0/7']],
    ['loopback', ['127.0.0.0/8']],
    ['multicast', ['224.0.0.0/8']],
    ['an option-like value', ['--help']],
    ['overlap within the list', ['10.1.0.0/16', '10.1.2.0/24']],
    ['too many entries', Array.from({ length: 65 }, (_, i) => `10.${i}.0.0/16`)],
  ])('%s is refused with a 422', (_label, input) => {
    expect(() => normalizeRoutedSubnets(input)).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});

describe('confirmRoutes', () => {
  test.each([
    ['the same subnet', '192.168.88.0/24'],
    ['a more specific prefix', '192.168.88.128/25'],
    ['a wider prefix', '192.168.0.0/16'],
  ])("%s as another tunnel's route is a 409 that names no foreign ids", async (_label, cidr) => {
    wire([{ id: 2, tunnel_address: '10.255.0.3', routed_subnets: '["192.168.88.0/24"]' }]);

    const err = await confirmRoutes({ id: 7 }, { subnets: [cidr] }).catch(e => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).not.toMatch(/tunnel 2|NAS \d/);
    expect(conn.query.mock.calls.some(([sql]) => /UPDATE nas_wg_tunnels SET routed_subnets/.test(sql))).toBe(false);
    expect(conn.rollback).toHaveBeenCalled();
    expect(wg.syncPeer).not.toHaveBeenCalled();
  });

  test('the hub subnet and other tunnel addresses cannot be claimed', async () => {
    wire([]);
    await expect(confirmRoutes({ id: 7 }, { subnets: ['10.255.0.0/24'] })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a free subnet is stored under the row lock and synced', async () => {
    wire([{ id: 2, tunnel_address: '10.255.0.3', routed_subnets: '["192.168.88.0/24"]' }]);

    const result = await confirmRoutes({ id: 7 }, { subnets: ['192.168.89.0/24'] });

    expect(conn.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    const update = conn.query.mock.calls.find(([sql]) => /UPDATE nas_wg_tunnels SET routed_subnets/.test(sql));
    expect(update[1]).toEqual(['["192.168.89.0/24"]', 1]);
    expect(conn.commit).toHaveBeenCalled();
    expect(wg.syncPeer).toHaveBeenCalledWith(expect.objectContaining({ subnets: ['192.168.89.0/24'] }));
    expect(result.steps.find(s => s.step === 'overlap-check').status).toBe('ok');
  });
});

describe('PUT /nas/:id/wg/routes', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const app = require('../src/app');
  const Nas = require('../src/models/Nas');
  const User = require('../src/models/User');

  test('an overlap answers 409, not a 502 router error', async () => {
    jest.spyOn(User, 'findById').mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
    jest.spyOn(Nas, 'findByIdOrFail').mockResolvedValue({ id: 7, organization_id: 1 });
    wire([{ id: 2, tunnel_address: '10.255.0.3', routed_subnets: '["192.168.88.0/24"]' }]);
    const token = jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

    const res = await request(app).put('/api/v1/nas/7/wg/routes')
      .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1')
      .send({ subnets: ['192.168.88.0/24'] });

    expect(res.status).toBe(409);
  });
});
