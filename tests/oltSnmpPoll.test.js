'use strict';
// =============================================================================
// Scheduled OLT monitoring over SNMP (HUAWEI-XPON-MIB)
// =============================================================================
// Every OLT with SNMP enabled is walked for ONU state, distance, signal and
// last down cause, and the result is remembered per PON port with the same
// code the Live OLT tab uses. Object numbers and scales come from published
// copies of the MIB; they have not been checked against an OLT.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const mockRecord = jest.fn(async () => {});
jest.mock('../src/services/olt/fibreFaultService', () => ({ record: (...a) => mockRecord(...a) }));
jest.mock('../src/services/snmpPoller', () => ({ createSnmpSession: jest.fn(), snmpSubtree: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const snmp = require('../src/services/olt/oltSnmpPollService');

const PORT_0_1_0 = 4194312192; // 0xFA000000 + 1 * 8192
const PORT_0_2_5 = 4194304000 + 2 * 8192 + 5 * 256;
const vb = (column, ifIndex, ontId, value) => ({ oid: `${snmp.OID[column]}.${ifIndex}.${ontId}`, value });

const WALK = {
  runStatus: [vb('runStatus', PORT_0_1_0, 0, 1), vb('runStatus', PORT_0_1_0, 1, 2), vb('runStatus', PORT_0_2_5, 7, 1)],
  serial: [vb('serial', PORT_0_1_0, 0, Buffer.from('48575443A1B2C3D4', 'hex')), vb('serial', PORT_0_1_0, 1, Buffer.from('48575443A1B2C3D5', 'hex'))],
  description: [vb('description', PORT_0_1_0, 0, Buffer.from('contract-1001')), vb('description', PORT_0_1_0, 1, Buffer.from('contract-1002\x00'))],
  lastDownCause: [vb('lastDownCause', PORT_0_1_0, 0, 13), vb('lastDownCause', PORT_0_1_0, 1, 2)],
  ranging: [vb('ranging', PORT_0_1_0, 0, 1500), vb('ranging', PORT_0_1_0, 1, -1), vb('ranging', PORT_0_2_5, 7, 320)],
  rxPower: [vb('rxPower', PORT_0_1_0, 0, -1852), vb('rxPower', PORT_0_1_0, 1, 2147483647), vb('rxPower', PORT_0_2_5, 7, -2710)],
};

describe('which PON port an SNMP index is', () => {
  test('frame 0: base + slot * 8192 + port * 256', () => {
    expect(snmp.portOfIfIndex(PORT_0_1_0)).toBe('0/1/0');
    expect(snmp.portOfIfIndex(PORT_0_2_5)).toBe('0/2/5');
    expect(snmp.portOfIfIndex(4194304000)).toBe('0/0/0');
  });

  test('an index that is not a GPON port is not guessed at', () => {
    for (const bad of [17, 4194304001, 4194304000 + 64 * 8192, 'abc', null]) expect(snmp.portOfIfIndex(bad)).toBeNull();
  });
});

describe('turning a walk into ONUs', () => {
  const byPort = snmp.assemble(WALK);

  test('ONUs are grouped by port in the shape the command line gives', () => {
    expect([...byPort.keys()].sort()).toEqual(['0/1/0', '0/2/5']);
    expect(byPort.get('0/1/0')).toEqual([
      { port: '0/1/0', ont_id: 0, state: 'online', serial_number: '48575443A1B2C3D4', description: 'contract-1001', last_down_cause: 'dying-gasp', distance_m: 1500, rx_power_dbm: -18.52 },
      { port: '0/1/0', ont_id: 1, state: 'offline', serial_number: '48575443A1B2C3D5', description: 'contract-1002', last_down_cause: 'LOSi/LOBi', distance_m: null, rx_power_dbm: null },
    ]);
    expect(byPort.get('0/2/5')[0]).toMatchObject({ ont_id: 7, state: 'online', distance_m: 320, rx_power_dbm: -27.1 });
  });

  test('"no reading" values are not stored as readings', () => {
    const dark = byPort.get('0/1/0')[1];
    // -1 metres and 2147483647 are how the OLT says it has no value.
    expect(dark.distance_m).toBeNull();
    expect(dark.rx_power_dbm).toBeNull();
  });

  test('down causes are named as the command line names them, so both classify alike', () => {
    const { causeKind } = jest.requireActual('../src/services/olt/fibreFaultService');
    expect(causeKind(snmp.DOWN_CAUSES[1])).toBe('signal');
    expect(causeKind(snmp.DOWN_CAUSES[2])).toBe('signal');
    expect(causeKind(snmp.DOWN_CAUSES[3])).toBe('signal');
    expect(causeKind(snmp.DOWN_CAUSES[13])).toBe('power');
    expect(causeKind(snmp.DOWN_CAUSES[9])).toBe('other');
  });

  test('rows that are not ONU rows are ignored', () => {
    const odd = snmp.assemble({
      runStatus: [{ oid: `${snmp.OID.runStatus}.17.0`, value: 1 }, { oid: `${snmp.OID.runStatus}.${PORT_0_1_0}`, value: 1 }],
      ranging: [vb('ranging', PORT_0_1_0, 9, 100)], // distance with no run status
    });
    expect(odd.size).toBe(0);
  });
});

describe('polling', () => {
  const device = { id: 7, organization_id: 3, ip_address: '10.20.0.5' };
  const session = { close: jest.fn() };
  beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

  test('one OLT: every port is remembered under its organization', async () => {
    const subtree = jest.fn(async (_s, oid) => WALK[Object.keys(snmp.OID).find((k) => snmp.OID[k] === oid)]);
    await expect(snmp.pollOlt(device, { createSession: () => session, subtree })).resolves.toEqual({ ports: 2, onus: 3 });
    expect(mockRecord).toHaveBeenCalledWith(3, 7, '0/1/0', expect.any(Array));
    expect(mockRecord).toHaveBeenCalledWith(3, 7, '0/2/5', expect.any(Array));
    expect(session.close).toHaveBeenCalled();
  });

  test('a column this release lacks does not lose the others', async () => {
    const subtree = jest.fn(async (_s, oid) => {
      if (oid === snmp.OID.rxPower) throw new Error('noSuchObject');
      return WALK[Object.keys(snmp.OID).find((k) => snmp.OID[k] === oid)];
    });
    await expect(snmp.pollOlt(device, { createSession: () => session, subtree })).resolves.toEqual({ ports: 2, onus: 3 });
    expect(mockRecord.mock.calls[0][3][0]).toMatchObject({ distance_m: 1500 });
    expect(mockRecord.mock.calls[0][3][0].rx_power_dbm).toBeUndefined();
  });

  test('no answer for run status fails that OLT, and its session is still closed', async () => {
    const subtree = jest.fn(async () => { throw new Error('Request timed out'); });
    await expect(snmp.pollOlt(device, { createSession: () => session, subtree })).rejects.toThrow('Request timed out');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
  });

  test('only OLTs with SNMP enabled that belong to an organization are polled', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(snmp.pollAll()).resolves.toMatchObject({ olts: 0, polled: 0, failed: 0 });
    expect(db.query.mock.calls[0][0].replace(/\s+/g, ' ')).toMatch(/WHERE type = 'olt' AND snmp_enabled = 1 AND deleted_at IS NULL AND organization_id IS NOT NULL/);
  });

  test('the scheduled task runs it', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'taskRunner.js'), 'utf8');
    expect(runner).toMatch(/case 'ftth_onu_optical_poll':[\s\S]{0,260}require\('\.\/olt\/oltSnmpPollService'\)\.pollAll\(organizationId\);/);
  });
});
