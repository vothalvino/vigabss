'use strict';
// =============================================================================
// Is the fibre cut, and how far away?
// =============================================================================
// Judged from what a GPON OLT reports for a PON port: who is online, why the
// others went down, and how far each ONU was while it was online. A break is
// upstream of every ONU it took down, so it is no farther from the OLT than
// the nearest of them. This is an upper bound, not an OTDR measurement.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const db = require('../src/config/database');
const fault = require('../src/services/olt/fibreFaultService');

const onu = (ont_id, state, last_down_cause, distance_m) => ({ ont_id, state, last_down_cause, distance_m });

describe('judging a PON port', () => {
  test('everyone online: the fibre is fine', () => {
    expect(fault.analyse([onu(0, 'online', null, 800), onu(1, 'online', null, 1500)])).toMatchObject({
      verdict: 'healthy', total: 2, online: 2, lost_signal: 0, nearest_affected_m: null,
    });
  });

  test('ONUs down for lack of mains power are not a fibre fault', () => {
    expect(fault.analyse([onu(0, 'online', null, 800), onu(1, 'offline', 'dying-gasp', 1500)])).toMatchObject({
      verdict: 'no_fibre_fault', lost_signal: 0, lost_power: 1, affected: [],
    });
  });

  test('every ONU without signal: the shared fibre (or the port)', () => {
    const result = fault.analyse([onu(0, 'offline', 'LOSi/LOBi', 1200), onu(1, 'offline', 'LOSi/LOBi', 950), onu(2, 'offline', 'LOFi', 2100)]);
    expect(result).toMatchObject({ verdict: 'whole_port', online: 0, lost_signal: 3, affected: [0, 1, 2] });
    // The break is upstream of all of them: no farther than the nearest.
    expect(result.nearest_affected_m).toBe(950);
    expect(result.farthest_affected_m).toBe(2100);
  });

  test('some ONUs without signal while others work: a branch', () => {
    const result = fault.analyse([
      onu(0, 'online', null, 400), onu(1, 'offline', 'LOSi/LOBi', 1800), onu(2, 'offline', 'LOS', 1650), onu(3, 'offline', 'dying-gasp', 900),
    ]);
    expect(result).toMatchObject({ verdict: 'branch', online: 1, lost_signal: 2, lost_power: 1, affected: [1, 2], nearest_affected_m: 1650 });
  });

  test('one ONU without signal: its own drop', () => {
    expect(fault.analyse([onu(0, 'online', null, 400), onu(1, 'offline', 'LOSi/LOBi', 1800)])).toMatchObject({
      verdict: 'single_onu', nearest_affected_m: 1800, farthest_affected_m: 1800,
    });
  });

  test('a signal loss with no remembered distance is still a break, with no distance claimed', () => {
    expect(fault.analyse([onu(0, 'offline', 'LOSi/LOBi', null), onu(1, 'offline', 'LOSi/LOBi', undefined)])).toMatchObject({
      verdict: 'whole_port', nearest_affected_m: null, affected_without_distance: 2,
    });
  });

  test('an empty port, and causes that are neither signal nor power', () => {
    expect(fault.analyse([])).toMatchObject({ verdict: 'no_onus', total: 0 });
    expect(fault.analyse([onu(0, 'online', null, 1), onu(1, 'offline', 'deactivated', 500)])).toMatchObject({ verdict: 'no_fibre_fault', offline_other: 1 });
    expect(fault.causeKind('LOSi/LOBi')).toBe('signal');
    expect(fault.causeKind('dying-gasp')).toBe('power');
    expect(fault.causeKind('ont-reset')).toBe('other');
    // "LOSS" inside another word is not LOS.
    expect(fault.causeKind('glossary')).toBe('other');
  });
});

describe('remembering a read', () => {
  beforeEach(() => { db.query.mockReset(); db.query.mockResolvedValue([[]]); });

  test('an online ONU stores its distance; an offline one keeps the distance it had', async () => {
    await fault.record(3, 7, '0/1/0', [
      { ont_id: 0, state: 'online', serial_number: '48575443A1B2C3D4', model: 'HG8245H', distance_m: 1500, rx_power_dbm: -18.5 },
      { ont_id: 1, state: 'offline', serial_number: '48575443A1B2C3D5', last_down_cause: 'LOSi/LOBi', distance_m: null },
    ]);
    const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO olt_onu_readings/.test(sql));
    expect(inserts).toHaveLength(2);
    // Stored distance survives a read in which the ONU reports none.
    expect(inserts[0][0]).toMatch(/distance_m = COALESCE\(VALUES\(distance_m\), distance_m\)/);
    expect(inserts[0][0]).toMatch(/last_online_at = COALESCE\(VALUES\(last_online_at\), last_online_at\)/);
    expect(inserts[0][1]).toEqual([3, 7, '0/1/0', 0, '48575443A1B2C3D4', 'HG8245H', null, 'online', null, 1500, -18.5]);
    expect(inserts[1][1].slice(7)).toEqual(['offline', 'LOSi/LOBi', null, null]);
    expect(inserts[1][0]).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, NULL, NOW\(\)\)/);
  });

  test('ONUs no longer on the port are forgotten, within the organization and OLT', async () => {
    await fault.record(3, 7, '0/1/0', [{ ont_id: 0, state: 'online' }, { ont_id: 4, state: 'online' }]);
    const del = db.query.mock.calls.find(([sql]) => /DELETE FROM olt_onu_readings/.test(sql));
    expect(del[0].replace(/\s+/g, ' ')).toMatch(/WHERE organization_id = \? AND olt_device_id = \? AND port = \? AND ont_id NOT IN \(\?, \?\)/);
    expect(del[1]).toEqual([3, 7, '0/1/0', 0, 4]);
  });

  test('a port with no ONUs clears what was remembered for it', async () => {
    await fault.record(3, 7, '0/1/0', []);
    expect(db.query.mock.calls).toHaveLength(1);
    expect(db.query.mock.calls[0][1]).toEqual([3, 7, '0/1/0']);
  });

  test('the verdict uses the remembered distance of ONUs that are now dark', async () => {
    db.query.mockImplementation(async (sql) => (/^\s*SELECT/.test(sql)
      ? [[
        { ont_id: 0, state: 'offline', last_down_cause: 'LOSi/LOBi', distance_m: 1500, rx_power_dbm: '-18.50' },
        { ont_id: 1, state: 'offline', last_down_cause: 'LOSi/LOBi', distance_m: 1320, rx_power_dbm: null },
      ]]
      : [{ affectedRows: 1 }]));
    const result = await fault.assess(3, 7, { port: '0/1/0', onus: [{ ont_id: 0, state: 'offline', last_down_cause: 'LOSi/LOBi' }, { ont_id: 1, state: 'offline', last_down_cause: 'LOSi/LOBi' }] });
    expect(result.fault).toMatchObject({ verdict: 'whole_port', nearest_affected_m: 1320, farthest_affected_m: 1500 });
    const select = db.query.mock.calls.find(([sql]) => /^\s*SELECT/.test(sql));
    expect(select[0].replace(/\s+/g, ' ')).toMatch(/WHERE organization_id = \? AND olt_device_id = \? AND port = \?/);
    expect(select[1]).toEqual([3, 7, '0/1/0']);
  });
});
