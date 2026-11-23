'use strict';
// =============================================================================
// Huawei MA5800 / EA5800 driver: read operations
// =============================================================================
// Written from Huawei's command reference; not yet run against hardware. The
// outputs below follow the documented layouts with invented serial numbers.
// Each operation also returns the raw text, so an unrecognised layout on a
// real OLT is visible instead of silently empty.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const { CliSession } = require('../src/services/olt/cliSession');
const huawei = require('../src/services/olt/huaweiMa5800');
const { scriptedOlt } = require('./helpers/scriptedOlt');

const VERSION = [
  '  VERSION : MA5800V100R019C10',
  '  PATCH   : SPH210',
  '  PRODUCT : MA5800-X7',
  '',
  '  Uptime is 12 day(s), 3 hour(s), 4 minute(s), 5 second(s)',
].join('\n');

const BOARDS = [
  '  -------------------------------------------------------------------------',
  '  SlotID  BoardName  Status          SubType0 SubType1    Online/Offline',
  '  -------------------------------------------------------------------------',
  '  0',
  '  1       H901GPHF   Normal',
  '  2       H901XGHD   Normal',
  '  3',
  '  8       H901MPLA   Active_normal',
  '  9       H901MPLA   Standby_normal',
  '  -------------------------------------------------------------------------',
].join('\n');

const AUTOFIND = [
  '   ----------------------------------------------------------------------------',
  '   Number              : 1',
  '   F/S/P               : 0/1/0',
  '   Ont SN              : 48575443A1B2C3D4 (HWTC-A1B2C3D4)',
  '   Password            : 0x00000000000000000000',
  '   Loid                : ',
  '   Checkcode           : ',
  '   VendorID            : HWTC',
  '   Ont Version         : 5D3.A',
  '   Ont SoftwareVersion : V5R019C00S100',
  '   Ont EquipmentID     : HG8245H',
  '   Ont autofind time   : 2026-01-05 10:00:00+08:00',
  '   ----------------------------------------------------------------------------',
  '   Number              : 2',
  '   F/S/P               : 0/ 1/3',
  '   Ont SN              : 485754430000ABCD (HWTC-0000ABCD)',
  '   VendorID            : HWTC',
  '   Ont EquipmentID     : EG8145V5',
  '   Ont autofind time   : 2026-01-05 10:02:11+08:00',
  '   ----------------------------------------------------------------------------',
  '   The number of GPON autofind ONT is 2',
].join('\n');

const SUMMARY = [
  '  ------------------------------------------------------------------------------',
  '  In port 0/ 1/0 , the total of ONTs are: 3, online: 2',
  '  ------------------------------------------------------------------------------',
  '  ONT  Run     Last                Last                Last',
  '  ID   State   UpTime              DownTime            DownCause',
  '  ------------------------------------------------------------------------------',
  '  0    online  2026-01-05 10:00:00 2026-01-03 09:00:00 dying-gasp',
  '  1    offline -                   2026-01-03 09:00:00 LOSi/LOBi',
  '  2    online  2026-01-04 08:30:00 -                   -',
  '  ------------------------------------------------------------------------------',
  '  ONT        SN        Type          Distance Rx/Tx power  Description',
  '  ID                                    (m)      (dBm)',
  '  ------------------------------------------------------------------------------',
  '  0   48575443A1B2C3D4 HG8245H       1500     -18.52/2.31  contract-1001',
  '  1   48575443A1B2C3D5 HG8310M       -        -/-          contract-1002',
  '  2   48575443A1B2C3D6 EG8145V5      320      -27.10/2.05  casa de Ana',
  '  ------------------------------------------------------------------------------',
].join('\n');

describe('reading what the OLT prints', () => {
  test('software version', () => {
    expect(huawei.parseVersion(VERSION)).toEqual({
      version: 'MA5800V100R019C10', patch: 'SPH210', product: 'MA5800-X7',
      uptime: '12 day(s), 3 hour(s), 4 minute(s), 5 second(s)',
    });
  });

  test('boards: empty slots are skipped, PON and control boards are told apart', () => {
    expect(huawei.parseBoards(BOARDS).map((b) => [b.slot, b.board, b.status, b.kind])).toEqual([
      [1, 'H901GPHF', 'Normal', 'pon'], [2, 'H901XGHD', 'Normal', 'pon'],
      [8, 'H901MPLA', 'Active_normal', 'control'], [9, 'H901MPLA', 'Standby_normal', 'control'],
    ]);
  });

  test('unregistered ONUs: one per block, the port without the spaces some releases print', () => {
    expect(huawei.parseAutofind(AUTOFIND)).toEqual([
      {
        port: '0/1/0', serial_number: '48575443A1B2C3D4', serial_display: 'HWTC-A1B2C3D4', loid: null,
        vendor_id: 'HWTC', hardware_version: '5D3.A', software_version: 'V5R019C00S100', model: 'HG8245H',
        found_at: '2026-01-05 10:00:00+08:00',
      },
      {
        port: '0/1/3', serial_number: '485754430000ABCD', serial_display: 'HWTC-0000ABCD',
        vendor_id: 'HWTC', model: 'EG8145V5', found_at: '2026-01-05 10:02:11+08:00',
      },
    ]);
  });

  test('ONUs on a port: the state table and the optical table are merged by ONT id', () => {
    const parsed = huawei.parseOntSummary(SUMMARY);
    expect(parsed.reported_total).toBe(3);
    expect(parsed.reported_online).toBe(2);
    expect(parsed.onus).toEqual([
      {
        ont_id: 0, state: 'online', last_up: '2026-01-05 10:00:00', last_down: '2026-01-03 09:00:00', last_down_cause: 'dying-gasp',
        serial_number: '48575443A1B2C3D4', model: 'HG8245H', distance_m: 1500, rx_power_dbm: -18.52, tx_power_dbm: 2.31, description: 'contract-1001',
      },
      {
        ont_id: 1, state: 'offline', last_up: null, last_down: '2026-01-03 09:00:00', last_down_cause: 'LOSi/LOBi',
        serial_number: '48575443A1B2C3D5', model: 'HG8310M', distance_m: null, rx_power_dbm: null, tx_power_dbm: null, description: 'contract-1002',
      },
      {
        ont_id: 2, state: 'online', last_up: '2026-01-04 08:30:00', last_down: null, last_down_cause: null,
        serial_number: '48575443A1B2C3D6', model: 'EG8145V5', distance_m: 320, rx_power_dbm: -27.1, tx_power_dbm: 2.05, description: 'casa de Ana',
      },
    ]);
  });

  test('text in a layout nobody has seen yields nothing, not garbage', () => {
    expect(huawei.parseAutofind('something else entirely')).toEqual([]);
    expect(huawei.parseOntSummary('ONT ID  whatever').onus).toEqual([]);
    expect(huawei.parseBoards('')).toEqual([]);
  });

  test('a PON port is frame/slot/port', () => {
    expect(huawei.parseFsp('0/1/3')).toEqual({ frame: 0, slot: 1, port: 3 });
    expect(huawei.parseFsp(' 0/ 1/3 ')).toEqual({ frame: 0, slot: 1, port: 3 });
    for (const bad of ['0/1', '0/1/3; reboot', '', null, 'a/b/c']) {
      expect(() => huawei.parseFsp(bad)).toThrow(/frame\/slot\/port/);
    }
  });
});

describe('against a scripted OLT', () => {
  async function driverWith(answers) {
    const olt = scriptedOlt({ enable: '', 'undo smart': '', 'scroll 512': '', ...answers });
    const session = new CliSession(olt.stream, { timeoutMs: 500 });
    await session.ready();
    const driver = new huawei.HuaweiMa5800(session);
    await driver.prepare();
    return { driver, olt };
  }

  test('test connection: version and boards, with the raw text', async () => {
    const { driver, olt } = await driverWith({ 'display version': VERSION, 'display board 0': BOARDS });
    const system = await driver.systemInfo();
    expect(system.product).toBe('MA5800-X7');
    expect(system.raw).toMatch(/VERSION : MA5800V100R019C10/);
    expect((await driver.boards()).boards).toHaveLength(4);
    expect(olt.typed).toEqual(['enable', 'undo smart', 'scroll 512', 'display version', 'display board 0']);
  });

  test('a release without the tuning commands still works', async () => {
    const olt = scriptedOlt({ enable: '', 'display version': VERSION });
    const session = new CliSession(olt.stream, { timeoutMs: 500 });
    await session.ready();
    const driver = new huawei.HuaweiMa5800(session);
    await driver.prepare();
    await expect(driver.systemInfo()).resolves.toMatchObject({ version: 'MA5800V100R019C10' });
  });

  test('no unregistered ONUs is an empty list, not an error', async () => {
    const { driver } = await driverWith({ 'display ont autofind all': '  Failure: The automatically found ONTs do not exist' });
    await expect(driver.unregisteredOnus()).resolves.toMatchObject({ onus: [] });
  });

  test('unregistered ONUs and the ONUs of a port', async () => {
    const { driver, olt } = await driverWith({ 'display ont autofind all': AUTOFIND, 'display ont info summary 0/1/0': SUMMARY });
    expect((await driver.unregisteredOnus()).onus.map((o) => o.serial_number)).toEqual(['48575443A1B2C3D4', '485754430000ABCD']);
    const port = await driver.onusOnPort('0/1/0');
    expect(port.port).toBe('0/1/0');
    expect(port.onus).toHaveLength(3);
    expect(olt.typed.slice(3)).toEqual(['display ont autofind all', 'display ont info summary 0/1/0']);
  });

  test('another failure from the OLT is reported with what it said', async () => {
    const { driver } = await driverWith({ 'display board 0': '  Failure: The frame does not exist' });
    await expect(driver.boards()).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: 'The OLT answered: The frame does not exist' });
  });

  test('only display commands are ever sent after the session is prepared', async () => {
    const { driver, olt } = await driverWith({ 'display version': VERSION });
    await expect(driver._display('ont delete 0 1')).rejects.toMatchObject({ code: 'NOT_A_READ' });
    await expect(driver._display('display version\nreboot')).rejects.toMatchObject({ code: 'NOT_A_READ' });
    await expect(driver.onusOnPort('0/1/0 ; reboot')).rejects.toMatchObject({ code: 'INVALID_PORT' });
    expect(olt.typed.filter((c) => !/^(enable|undo smart|scroll 512|display )/.test(c))).toEqual([]);
  });

  test('being refused privileged mode is an error', async () => {
    const olt = scriptedOlt({ enable: '  Failure: Insufficient privilege' });
    const session = new CliSession(olt.stream, { timeoutMs: 500 });
    await session.ready();
    await expect(new huawei.HuaweiMa5800(session).prepare()).rejects.toMatchObject({ code: 'ENABLE_FAILED' });
  });
});
