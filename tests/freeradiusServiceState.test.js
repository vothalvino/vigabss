// =============================================================================
// NET-03 / NPR-02 — FreeRADIUS SQL rows follow the subscriber's service state
// =============================================================================
// NET-03: suspend, terminate, status edits and RADIUS account delete/rename
// only flipped radius.status; the rad* rows external FreeRADIUS authenticates
// from were only ever rewritten for ACTIVE accounts, so a suspended or
// terminated subscriber kept authenticating.
// NPR-02: a PPPoE static IP set on the contract never reached radius, and the
// periodic sync deleted radreply and never wrote Framed-IP-Address.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const radiusService = require('../src/services/radiusService');
const suspensionService = require('../src/services/suspensionService');

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
  db.getConnection.mockReset();
});

const SUB = {
  id: 1, username: 'pppoe-1', cleartext_password: 'pw', auth_method: 'pppoe',
  organization_id: 1, contract_status: 'active', plan_id: null,
};

function routeSync({ subscribers = [SUB], stale = [] } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM radius r\s+LEFT JOIN contracts c ON c.id = r.contract_id\s+LEFT JOIN plans p/.test(sql)) return [subscribers];
    if (/SELECT DISTINCT r\.username/.test(sql)) return [stale];
    return [[]];
  });
}

const inserts = (attribute) => db.query.mock.calls
  .filter(([sql, params]) => /^INSERT INTO radreply/.test(sql) && params[1] === attribute);

describe('syncFreeradiusTables', () => {
  test('a full run removes the rows of accounts that may no longer authenticate', async () => {
    routeSync({ stale: [{ username: 'suspended-user' }] });

    const result = await radiusService.syncFreeradiusTables(1);

    const [sql, params] = db.query.mock.calls.find(([q]) => /SELECT DISTINCT r\.username/.test(q));
    expect(sql).toContain("r.status <> 'active'");
    expect(sql).toContain('EXISTS (SELECT 1 FROM radcheck rc WHERE rc.username = r.username)');
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM radius r2/);
    expect(params).toEqual([1]);
    for (const table of ['radcheck', 'radreply', 'radusergroup']) {
      expect(db.query).toHaveBeenCalledWith(`DELETE FROM ${table} WHERE username = ?`, ['suspended-user']);
    }
    expect(result.purged).toBe(1);
  });

  test('a single-contract run writes only that contract and purges nothing else', async () => {
    routeSync({ stale: [{ username: 'other' }] });

    await radiusService.syncFreeradiusTables(1, { contractId: 42 });

    const [sql, params] = db.query.mock.calls.find(([q]) => /LEFT JOIN plans p/.test(q));
    expect(sql).toContain('AND r.contract_id = ?');
    expect(params).toEqual([1, 42]);
    expect(db.query.mock.calls.some(([q]) => /SELECT DISTINCT r\.username/.test(q))).toBe(false);
  });

  test('a static IPv4 is written as Framed-IP-Address with a host netmask', async () => {
    routeSync({ subscribers: [{ ...SUB, static_ip: '203.0.113.7' }] });

    await radiusService.syncFreeradiusTables(1);

    expect(inserts('Framed-IP-Address').map(([, p]) => p)).toEqual([['pppoe-1', 'Framed-IP-Address', ':=', '203.0.113.7']]);
    expect(inserts('Framed-IP-Netmask')).toHaveLength(1);
  });

  test('an IPv6 or empty address writes no Framed-IP-Address', async () => {
    routeSync({ subscribers: [{ ...SUB, static_ip: '2001:db8::1' }, { ...SUB, id: 2, username: 'p2', static_ip: null }] });
    await radiusService.syncFreeradiusTables(1);
    expect(inserts('Framed-IP-Address')).toHaveLength(0);
  });
});

describe('suspendContract', () => {
  test("removes the subscriber's FreeRADIUS rows in the transaction and disconnects after the commit", async () => {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/FOR UPDATE/.test(sql)) return [[{ id: 10, status: 'active', organization_id: 1 }]];
        return [{ affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    db.query.mockResolvedValue([[]]);
    const purge = jest.spyOn(radiusService, 'syncFreeradiusContract').mockResolvedValue({ found: true, enabled: false });
    const disconnect = jest.spyOn(suspensionService, 'sendRadiusDisconnect');

    await suspensionService.suspendContract(10, null, 5, null);

    expect(purge).toHaveBeenCalledWith(10, { organizationId: 1, enabled: false, runner: conn });
    expect(purge.mock.invocationCallOrder[0]).toBeLessThan(conn.commit.mock.invocationCallOrder[0]);
    // The disconnect lookup runs after the commit (db.query, not the transaction).
    const lookup = db.query.mock.calls.findIndex(([sql]) => /FROM radius/.test(sql));
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(db.query.mock.invocationCallOrder[lookup]).toBeGreaterThan(conn.commit.mock.invocationCallOrder[0]);
    disconnect.mockRestore();
  });
});

describe('reconnectContract', () => {
  test("writes the subscriber's rows back immediately", async () => {
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/FOR UPDATE/.test(sql)) return [[{ id: 10, status: 'suspended', first_activated_at: new Date(), organization_id: 1 }]];
        if (/FROM organizations o/.test(sql)) return [[{ locale: 'global' }]];
        return [{ affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    db.query.mockResolvedValue([[]]);
    const restore = jest.spyOn(radiusService, 'syncFreeradiusTables').mockResolvedValue({ synced: 1 });

    await suspensionService.reconnectContract(10, 5, null, { orgId: 1 });

    expect(restore).toHaveBeenCalledWith(1, { contractId: 10 });
  });
});

describe('provisioning copies the contract static IP to RADIUS', () => {
  test('a PPPoE contract with a static IPv4 gets it on its RADIUS account', async () => {
    const provisioning = require('../src/services/subscriberProvisioningService');
    const runner = {
      query: jest.fn(async (sql) => {
        if (/INSERT INTO radius/.test(sql)) return [{ insertId: 7 }];
        if (/FROM ip_pools/.test(sql)) return [[]];
        return [[]];
      }),
    };

    await provisioning.provisionNewContract(
      runner,
      { id: 3, client_id: 2, organization_id: 1, connection_type: 'pppoe', ip_address: '203.0.113.9' },
      { pppoeUsername: 'u1', pppoePassword: 'p1' },
    ).catch(() => {}); // later steps are not modelled

    const [sql, params] = runner.query.mock.calls.find(([q]) => /INSERT INTO radius/.test(q));
    expect(sql).toContain('ip_address');
    expect(params).toContain('203.0.113.9');
  });
});

describe('routes remove FreeRADIUS rows when service goes off', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const User = require('../src/models/User');
  const Radius = require('../src/models/Radius');
  const Contract = require('../src/models/Contract');
  const app = require('../src/app');
  const token = jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
  const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

  beforeEach(() => {
    jest.spyOn(User, 'findById').mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
    db.query.mockResolvedValue([[]]);
  });

  test('terminating a contract purges its rows before the disconnect', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM contracts WHERE id = \?/.test(sql)) return [[{ id: 8, organization_id: 1, status: 'active' }]];
      return [[]];
    });
    jest.spyOn(Contract, 'update').mockResolvedValue({ id: 8, organization_id: 1, status: 'terminated' });
    const purge = jest.spyOn(radiusService, 'syncFreeradiusContract').mockResolvedValue({ found: true, enabled: false });
    const disconnect = jest.spyOn(suspensionService, 'sendRadiusDisconnect').mockResolvedValue({ sent: true });

    const res = await call('post', '/contracts/8/terminate', {});

    expect(res.status).toBeLessThan(300);
    expect(purge).toHaveBeenCalledWith(8, { organizationId: 1, enabled: false });
    expect(purge.mock.invocationCallOrder[0]).toBeLessThan(disconnect.mock.invocationCallOrder[0]);
  });

  test("deleting a RADIUS account removes that username's rows", async () => {
    const account = { id: 4, username: 'gone-user', status: 'active', contract_id: null };
    jest.spyOn(Radius, 'findByIdOrFail').mockResolvedValue(account);
    jest.spyOn(Radius, 'findById').mockResolvedValue(account);
    jest.spyOn(Radius, 'delete').mockResolvedValue(true);

    await call('delete', '/radius/4');

    expect(db.query).toHaveBeenCalledWith('DELETE FROM radcheck WHERE username = ?', ['gone-user']);
    expect(db.query).toHaveBeenCalledWith('DELETE FROM radusergroup WHERE username = ?', ['gone-user']);
  });

  test("renaming a RADIUS account removes the old username's rows", async () => {
    const account = { id: 4, username: 'old-name', status: 'active', contract_id: null };
    jest.spyOn(Radius, 'findByIdOrFail').mockResolvedValue(account);
    jest.spyOn(Radius, 'findById').mockResolvedValue(account);
    jest.spyOn(Radius, 'update').mockResolvedValue({ ...account, username: 'new-name' });

    await call('put', '/radius/4', { username: 'new-name' });

    expect(db.query).toHaveBeenCalledWith('DELETE FROM radcheck WHERE username = ?', ['old-name']);
  });
});
