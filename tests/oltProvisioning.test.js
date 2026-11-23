'use strict';
// =============================================================================
// Provisioning ONUs on a Huawei OLT
// =============================================================================
// Every change is a plan of exact command lines first. A preview returns the
// plan and sends nothing that changes the OLT; applying sends exactly those
// lines, stops at the first refusal and logs what was sent and answered.
// Written from Huawei's documented provisioning sequence; not run on hardware.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const mockConn = { row: null, driver: null };
jest.mock('../src/services/olt/oltConnectionService', () => ({
  connectionRow: jest.fn(async () => mockConn.row),
  assertOlt: jest.fn(async () => ({ id: 7 })),
  withDriver: jest.fn(async (_olt, _org, work) => work(mockConn.driver)),
}));

const db = require('../src/config/database');
const write = require('../src/services/olt/huaweiMa5800Write');
const { CliSession } = require('../src/services/olt/cliSession');
const { HuaweiMa5800 } = require('../src/services/olt/huaweiMa5800');
const provisioning = require('../src/services/olt/oltProvisioningService');
const { scriptedOlt } = require('./helpers/scriptedOlt');

const commands = (plan) => plan.map((s) => s.command);

describe('the commands', () => {
  test('authorising an ONU: add it on its board, then its service-port with both speed limits', () => {
    expect(commands(write.planAuthorise({
      port: '0/1/0', ontId: 3, serial: '48575443a1b2c3d4', lineProfileId: 20, srvProfileId: 20,
      vlan: 200, gemPort: 2, upTableIndex: 201, downTableIndex: 200, description: 'contract 1001',
    }))).toEqual([
      'config',
      'interface gpon 0/1',
      'ont add 0 3 sn-auth "48575443A1B2C3D4" omci ont-lineprofile-id 20 ont-srvprofile-id 20 desc "contract-1001"',
      'quit',
      'service-port vlan 200 gpon 0/1/0 ont 3 gemport 2 multi-service user-vlan 200 tag-transform translate inbound traffic-table index 201 outbound traffic-table index 200',
      'quit',
    ]);
  });

  test('an untagged ONU port is set only when asked for', () => {
    const plan = commands(write.planAuthorise({
      port: '0/1/0', ontId: 3, serial: '48575443A1B2C3D4', lineProfileId: 20, srvProfileId: 20,
      vlan: 200, userVlan: 10, gemPort: 2, upTableIndex: 201, downTableIndex: 200, description: 'c1', nativeVlanEthPort: 1,
    }));
    expect(plan).toContain('ont port native-vlan 0 3 eth 1 vlan 10 priority 0');
    expect(plan.find((c) => c.startsWith('service-port'))).toMatch(/multi-service user-vlan 10 /);
  });

  test('a rate limit, a speed change, switching off and removing', () => {
    expect(commands(write.planTrafficTable({ index: 200, name: 'VIGA-100000K', kbps: 100000 }))).toEqual([
      'config', 'traffic table ip index 200 name "VIGA-100000K" cir 100000 pir 100000 priority 0 priority-policy local-setting', 'quit',
    ]);
    expect(commands(write.planSetSpeed({ port: '0/1/0', ontId: 3, servicePortIndex: 1002, vlan: 200, gemPort: 2, upTableIndex: 203, downTableIndex: 202 }))).toEqual([
      'config', 'undo service-port 1002',
      'service-port 1002 vlan 200 gpon 0/1/0 ont 3 gemport 2 multi-service user-vlan 200 tag-transform translate inbound traffic-table index 203 outbound traffic-table index 202',
      'quit',
    ]);
    expect(commands(write.planSetActive({ port: '0/1/0', ontId: 3, active: false }))).toEqual(['config', 'interface gpon 0/1', 'ont deactivate 0 3', 'quit', 'quit']);
    expect(commands(write.planRemove({ port: '0/1/0', ontId: 3, servicePortIndexes: [1002, 1003] }))).toEqual([
      'config', 'undo service-port 1002', 'undo service-port 1003', 'interface gpon 0/1', 'ont delete 0 3', 'quit', 'quit',
    ]);
  });

  test('no value can carry another command onto the line', () => {
    const base = { port: '0/1/0', ontId: 3, serial: '48575443A1B2C3D4', lineProfileId: 20, srvProfileId: 20, vlan: 200, gemPort: 2, upTableIndex: 1, downTableIndex: 1, description: 'ok' };
    for (const bad of [
      { description: 'x" ; reboot system' }, { description: 'a\nreboot' }, { serial: '48575443A1B2C3D4 0' }, { serial: 'HWTC-A1B2C3D4' },
      { port: '0/1/0 ; quit' }, { ontId: '3 4' }, { vlan: '200 gpon' }, { lineProfileId: -1 }, { upTableIndex: 99999 },
    ]) {
      expect(() => write.planAuthorise({ ...base, ...bad })).toThrow();
    }
    // Every line of every plan is a single line of printable characters.
    for (const line of commands(write.planAuthorise(base))) expect(line).toMatch(/^[\x20-\x7e]+$/);
  });

  test('reading what the OLT answers', () => {
    expect(write.parseAddedOntId('  Number of ONTs that can be added: 1, success: 1\n  PortID :0, ONTID :3')).toBe(3);
    expect(write.parseServicePorts([
      '  INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE',
      '  -----------------------------------------------------------------------------',
      '   1002  200 common   gpon 0/1 /0  3    2     vlan  200        201  200  up',
      '  Total : 1  (Up/Down :    1/0)',
    ].join('\n'))).toEqual([{ index: 1002, vlan: 200 }]);
  });
});

describe('sending a plan', () => {
  async function sessionWith(answers) {
    const olt = scriptedOlt({ enable: '', 'undo smart': '', 'scroll 512': '', config: '', quit: '', ...answers });
    const session = new CliSession(olt.stream, { timeoutMs: 500 });
    await session.ready();
    return { session, olt };
  }

  test('every line is sent in order and its answer kept', async () => {
    const plan = write.planSetActive({ port: '0/1/0', ontId: 3, active: false });
    const { session, olt } = await sessionWith({ 'interface gpon 0/1': '', 'ont deactivate 0 3': '' });
    const result = await write.apply(session, plan);
    expect(result.ok).toBe(true);
    expect(olt.typed).toEqual(commands(plan));
    expect(result.transcript.map((t) => t.command)).toEqual(commands(plan));
  });

  test('a refusal stops the run there; nothing after it is sent', async () => {
    const plan = write.planRemove({ port: '0/1/0', ontId: 3, servicePortIndexes: [1002] });
    const { session, olt } = await sessionWith({ 'undo service-port 1002': '  Failure: Service virtual port does not exist' });
    const result = await write.apply(session, plan);
    expect(result).toMatchObject({ ok: false, failedAt: 1 });
    expect(result.transcript[1]).toMatchObject({ command: 'undo service-port 1002', failed: 'Service virtual port does not exist' });
    expect(olt.typed).toEqual(['config', 'undo service-port 1002']);
  });

  test('a question from the OLT is not answered: the run fails', async () => {
    const { session } = await sessionWith({ 'interface gpon 0/1': '', 'ont delete 0 3': { ask: ' Are you sure to delete the ONT? (y/n)[n]:' } });
    const result = await write.apply(session, write.planRemove({ port: '0/1/0', ontId: 3, servicePortIndexes: [] }));
    expect(result.ok).toBe(false);
    expect(result.transcript.at(-1).failed).toMatch(/confirmation/i);
  });
});

describe('authorising an ONU for a contract', () => {
  const SETTINGS = { line_profile_id: 20, srv_profile_id: 20, service_vlan: 200, user_vlan: null, gem_port: 2, native_vlan_eth_port: null, traffic_table_base: 200 };
  const SUMMARY = [
    '  In port 0/ 1/0 , the total of ONTs are: 2, online: 2',
    '  0    online  2026-01-05 10:00:00 -                   -',
    '  1    online  2026-01-05 10:00:00 -                   -',
    '  0   48575443AAAAAAAA HG8245H       100      -18.00/2.00  contract-1',
    '  1   48575443BBBBBBBB HG8245H       200      -19.00/2.00  contract-2',
  ].join('\n');

  async function openOlt(extra = {}) {
    const olt = scriptedOlt({
      enable: '', 'undo smart': '', 'scroll 512': '', config: '', quit: '', 'interface gpon 0/1': '',
      'display ont info summary 0/1/0': SUMMARY,
      'traffic table ip index 200 name "VIGA-20000K" cir 20000 pir 20000 priority 0 priority-policy local-setting': '  Create traffic descriptor record successfully',
      'traffic table ip index 201 name "VIGA-100000K" cir 100000 pir 100000 priority 0 priority-policy local-setting': '  Create traffic descriptor record successfully',
      'ont add 0 2 sn-auth "48575443A1B2C3D4" omci ont-lineprofile-id 20 ont-srvprofile-id 20 desc "contract-55"': '  Number of ONTs that can be added: 1, success: 1\n  PortID :0, ONTID :2',
      'service-port vlan 200 gpon 0/1/0 ont 2 gemport 2 multi-service user-vlan 200 tag-transform translate inbound traffic-table index 200 outbound traffic-table index 201': '',
      'display service-port port 0/1/0 ont 2': '   1002  200 common   gpon 0/1 /0  2    2     vlan  200        200  201  up',
      ...extra,
    });
    const session = new CliSession(olt.stream, { timeoutMs: 500 });
    await session.ready();
    mockConn.driver = new HuaweiMa5800(session);
    await mockConn.driver.prepare();
    return olt;
  }

  const statements = () => db.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
  function serveDb() {
    db.query.mockImplementation(async (sql) => {
      if (/FROM contracts c JOIN plans/.test(sql)) return [[{ upload_speed_mbps: 20, download_speed_mbps: 100 }]];
      if (/SELECT id FROM contracts/.test(sql)) return [[{ id: 55 }]];
      if (/FROM olt_traffic_tables/.test(sql)) return [[]];
      if (/INSERT INTO olt_onus/.test(sql)) return [{ insertId: 9 }];
      return [{ affectedRows: 1 }];
    });
  }

  beforeEach(() => { db.query.mockReset(); mockConn.row = { ...SETTINGS }; });

  test('a preview returns the commands and changes nothing', async () => {
    const olt = await openOlt();
    serveDb();
    const preview = await provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443a1b2c3d4', contractId: 55 });
    expect(preview).toMatchObject({ applied: false, port: '0/1/0', ont_id: 2, up_kbps: 20000, down_kbps: 100000, description: 'contract-55' });
    expect(preview.commands.map((c) => c.command)).toEqual([
      'config', 'traffic table ip index 200 name "VIGA-20000K" cir 20000 pir 20000 priority 0 priority-policy local-setting', 'quit',
      'config', 'traffic table ip index 201 name "VIGA-100000K" cir 100000 pir 100000 priority 0 priority-policy local-setting', 'quit',
      'config', 'interface gpon 0/1',
      'ont add 0 2 sn-auth "48575443A1B2C3D4" omci ont-lineprofile-id 20 ont-srvprofile-id 20 desc "contract-55"',
      'quit',
      'service-port vlan 200 gpon 0/1/0 ont 2 gemport 2 multi-service user-vlan 200 tag-transform translate inbound traffic-table index 200 outbound traffic-table index 201',
      'quit',
    ]);
    // Only reads reached the OLT, and nothing was written to the database.
    expect(olt.typed.filter((c) => !/^(enable|undo smart|scroll 512|display )/.test(c))).toEqual([]);
    expect(statements().some((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toBe(false);
  });

  test('applying sends the same commands, records the ONU with its service-port, the new tables and the operation', async () => {
    const olt = await openOlt();
    serveDb();
    const result = await provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443A1B2C3D4', contractId: 55 }, { apply: true, userId: 4 });
    expect(result).toMatchObject({ applied: true, ont_id: 2, service_port_index: 1002, id: 9 });
    expect(olt.typed).toEqual(expect.arrayContaining(result.commands.map((c) => c.command)));
    const onu = db.query.mock.calls.find(([sql]) => /INSERT INTO olt_onus/.test(sql));
    expect(onu[1]).toEqual([3, 7, '0/1/0', 2, '48575443A1B2C3D4', 55, 'contract-55', 1002, 20000, 100000, 4]);
    expect(db.query.mock.calls.filter(([sql]) => /INSERT IGNORE INTO olt_traffic_tables/.test(sql)).map(([, p]) => p)).toEqual([[3, 7, 200, 20000], [3, 7, 201, 100000]]);
    const op = db.query.mock.calls.find(([sql]) => /INSERT INTO olt_operations/.test(sql));
    expect(op[1].slice(0, 7)).toEqual([3, 7, 'authorise', '0/1/0', 2, '48575443A1B2C3D4', 55]);
    expect(op[1][8]).toBe('applied');
  });

  test('the lowest free ONT id is used, and an ONU already on the port is refused', async () => {
    await openOlt();
    serveDb();
    await expect(provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443AAAAAAAA', contractId: 55 })).rejects.toThrow(/already authorised/);
  });

  test('a speed VigaBSS already has a table for reuses it', async () => {
    await openOlt({
      'service-port vlan 200 gpon 0/1/0 ont 2 gemport 2 multi-service user-vlan 200 tag-transform translate inbound traffic-table index 210 outbound traffic-table index 211': '',
    });
    serveDb();
    db.query.mockImplementation(async (sql) => {
      if (/FROM contracts c JOIN plans/.test(sql)) return [[{ upload_speed_mbps: 20, download_speed_mbps: 100 }]];
      if (/SELECT id FROM contracts/.test(sql)) return [[{ id: 55 }]];
      if (/FROM olt_traffic_tables/.test(sql)) return [[{ table_index: 210, kbps: 20000 }, { table_index: 211, kbps: 100000 }]];
      return [{ affectedRows: 1 }];
    });
    const preview = await provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443A1B2C3D4', contractId: 55 });
    expect(preview.commands.some((c) => c.command.startsWith('traffic table'))).toBe(false);
    expect(preview.commands.at(-2).command).toMatch(/inbound traffic-table index 210 outbound traffic-table index 211$/);
  });

  test('a refusal is reported with the OLT\'s words, logged as failed, and the ONU is not recorded', async () => {
    await openOlt({
      'ont add 0 2 sn-auth "48575443A1B2C3D4" omci ont-lineprofile-id 20 ont-srvprofile-id 20 desc "contract-55"': '  Failure: The line profile does not exist',
    });
    serveDb();
    await expect(provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443A1B2C3D4', contractId: 55 }, { apply: true }))
      .rejects.toMatchObject({ statusCode: 502, code: 'OLT_COMMAND_REFUSED', message: expect.stringContaining('The line profile does not exist') });
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO olt_onus/.test(sql))).toBe(false);
    const op = db.query.mock.calls.find(([sql]) => /INSERT INTO olt_operations/.test(sql));
    expect(op[1][8]).toBe('failed');
    expect(op[1][9]).toBe('The line profile does not exist');
  });

  test('incomplete provisioning settings are named before anything is opened', async () => {
    mockConn.row = { ...SETTINGS, line_profile_id: null, gem_port: null };
    serveDb();
    await expect(provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443A1B2C3D4', contractId: 55 }))
      .rejects.toThrow(/line_profile_id, gem_port/);
  });

  test('the contract must belong to the organization', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(provisioning.authorise(3, 7, { port: '0/1/0', serial: '48575443A1B2C3D4', contractId: 999 })).rejects.toThrow(/does not exist/);
    expect(db.query.mock.calls[0]).toEqual(['SELECT id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [999, 3]]);
  });
});
