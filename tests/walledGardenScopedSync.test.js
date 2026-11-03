// =============================================================================
// NPR-08 — walling one contract touches only that subscriber
// =============================================================================
// walledGardenSuspendContract and walledGardenReconnect each ran a full
// organization FreeRADIUS resync (delete and reinsert every subscriber's rad*
// rows and all plan groups), once per walled contract in runAutoSuspend. The
// CoA carried no Mikrotik-Address-List, reconnect "removed" it with a CoA that
// cannot, and the embedded RADIUS server never sent the list at all.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/suspensionService', () => ({
  sendRadiusCoA: jest.fn(async () => ({ sent: true, response: 'ACK' })),
  sendRadiusDisconnect: jest.fn(async () => ({ sent: true, response: 'ACK' })),
  isClientSuspensionExempt: jest.fn(async () => ({ exempt: false })),
}));
jest.mock('../src/services/businessEvents', () => ({ emitContractSuspended: jest.fn() }));

const db = require('../src/config/database');
const suspension = require('../src/services/suspensionService');
const radiusService = require('../src/services/radiusService');

const SUBSCRIBER = {
  id: 5, username: 'walled-user', cleartext_password: 'pw', mac_address: null, auth_method: 'pap',
  account_sim_use: 1, vlan_id: null, inner_vlan_id: null, plan_id: 9, contract_id: 77, organization_id: 3,
  connection_type: 'pppoe', contract_status: 'active',
};

function wire({ walled = true } = {}) {
  const order = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    order.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    if (/SELECT organization_id FROM contracts/.test(sql)) return [[{ organization_id: 3 }]];
    if (/FROM organization_walled_garden_settings/.test(sql)) return [[{ address_list_name: 'moroso' }]];
    if (/FROM radius r/.test(sql) && /cleartext_password/.test(sql)) return [[SUBSCRIBER]];
    if (/FROM suspension_logs sl/.test(sql)) return [walled ? [{ username: 'walled-user' }] : []];
    if (/FROM plans/.test(sql)) return [[{ id: 9, name: 'Plan', radius_vendor: 'mikrotik', download_speed: 10000, upload_speed: 5000 }]];
    if (/^(INSERT|UPDATE|DELETE)/.test(sql.trim())) return [{ affectedRows: 1, insertId: 1 }];
    return [[]];
  });
  return order;
}

const deletes = () => db.query.mock.calls.filter(([sql]) => /^DELETE FROM rad(check|reply|usergroup)\b/.test(sql.trim()));

test('walling a contract sends the address list in the CoA and rewrites only that subscriber', async () => {
  wire();
  await radiusService.walledGardenSuspendContract(77, 12, null, 900);

  expect(suspension.sendRadiusCoA).toHaveBeenCalledWith(77, 'walled_garden', [{ name: 'Mikrotik-Address-List', value: 'moroso' }]);
  const subscriberSelect = db.query.mock.calls.find(([sql]) => /FROM radius r/.test(sql) && /cleartext_password/.test(sql));
  expect(subscriberSelect[0]).toMatch(/AND r\.contract_id = \?/);
  expect(subscriberSelect[1]).toContain(77);
  expect(deletes().length).toBeGreaterThan(0);
  for (const [, params] of deletes()) expect(params).toEqual(['walled-user']);
  // Its re-auth carries the list.
  const reply = db.query.mock.calls.find(([sql, p]) => /INSERT INTO radreply/.test(sql) && p[1] === 'Mikrotik-Address-List');
  expect(reply[1]).toEqual(['walled-user', 'Mikrotik-Address-List', ':=', 'moroso']);
});

test('reconnecting rewrites only that subscriber, then disconnects the session', async () => {
  const order = wire({ walled: false });
  suspension.sendRadiusDisconnect.mockClear();
  suspension.sendRadiusCoA.mockClear();

  await radiusService.walledGardenReconnect(77, null);

  for (const [, params] of deletes()) expect(params).toEqual(['walled-user']);
  expect(db.query.mock.calls.some(([sql, p]) => /INSERT INTO radreply/.test(sql) && p[1] === 'Mikrotik-Address-List')).toBe(false);
  expect(suspension.sendRadiusDisconnect).toHaveBeenCalledWith(77);
  expect(suspension.sendRadiusCoA).not.toHaveBeenCalled();
  // The rows are unwalled before the session is dropped and re-auths.
  expect(order.lastIndexOf('INSERT INTO radcheck')).toBeGreaterThanOrEqual(0);
  const disconnectAfterSync = suspension.sendRadiusDisconnect.mock.invocationCallOrder[0]
    > db.query.mock.invocationCallOrder[db.query.mock.calls.findIndex(([sql]) => /INSERT INTO radcheck/.test(sql))];
  expect(disconnectAfterSync).toBe(true);
});

describe('the embedded RADIUS server', () => {
  const server = require('../src/services/radiusServerService');
  const { encodeNamedAttributes } = require('../src/services/radiusCoaEncoder');
  const list = encodeNamedAttributes([{ name: 'Mikrotik-Address-List', value: 'moroso' }]);
  const base = { username: 'walled-user', ip_address: null, contract_status: 'active' };

  test('a walled subscriber is accepted onto the address list', () => {
    const attrs = server.buildAcceptAttributes({ ...base, walled_address_list: 'moroso' }, null, false);
    expect(attrs.includes(list)).toBe(true);
  });

  test('an unwalled one is not', () => {
    const attrs = server.buildAcceptAttributes({ ...base, walled_address_list: null }, null, false);
    expect(attrs.includes(list)).toBe(false);
  });

  test('the subscriber lookup reads the open walled-garden restriction', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'radiusServerService.js'), 'utf8');
    expect(src).toMatch(/WHERE sl\.contract_id = c\.id AND \$\{openWalledGardenPredicate\('sl'\)\}/);
  });
});
