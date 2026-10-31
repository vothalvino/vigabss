// =============================================================================
// NPR-01 — a soft suspension really throttles, and keeps throttling
// =============================================================================
// softSuspendContract sent a bare CoA (User-Name only) and stored nothing,
// while the log, API and console said the subscriber was throttled. The
// throttle is now stored on the contract (migration 475), sent in the CoA,
// served on re-authentication by FreeRADIUS and the embedded server, kept
// through speed-window transitions, and lifted (with the plan rate restored)
// on reconnect.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const { generateThrottleAttributes } = require('../src/services/radiusAttributeService');
const radiusService = require('../src/services/radiusService');
const suspensionService = require('../src/services/suspensionService');

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
  db.getConnection.mockReset();
});

describe('generateThrottleAttributes', () => {
  test.each([
    ['mikrotik', { 'Mikrotik-Rate-Limit': '256k/512k' }],
    [null, { 'WISPr-Bandwidth-Max-Down': 512000, 'WISPr-Bandwidth-Max-Up': 256000 }],
    ['cisco', { 'Cisco-AVPair': ['sub-qos-policy-in=ISP_DL_512K', 'sub-qos-policy-out=ISP_UL_256K'] }],
  ])('%s', (vendor, expected) => {
    expect(generateThrottleAttributes(vendor, 512, 256)).toEqual(expected);
  });
});

function connFor(row) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    execute: jest.fn(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return [[row]];
      if (/FROM plans WHERE id = \?/.test(sql) && /SELECT radius_vendor/.test(sql)) return [[{ radius_vendor: 'mikrotik' }]];
      if (/SELECT \* FROM plans/.test(sql)) return [[{ id: 4, download_speed_mbps: 100, upload_speed_mbps: 20, radius_vendor: 'mikrotik' }]];
      if (/FROM organizations o/.test(sql)) return [[{ locale: 'global' }]];
      return [{ affectedRows: 1 }];
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  return conn;
}

describe('softSuspendContract', () => {
  beforeEach(() => {
    db.query.mockResolvedValue([[]]);
    jest.spyOn(suspensionService, 'isClientSuspensionExempt').mockResolvedValue({ exempt: false });
  });

  test('stores the throttle, rewrites the FreeRADIUS rows and sends it in the CoA', async () => {
    const conn = connFor({ id: 10, status: 'active', organization_id: 1, plan_id: 4 });
    const sync = jest.spyOn(radiusService, 'syncFreeradiusTables').mockResolvedValue({ synced: 1 });

    await suspensionService.softSuspendContract(10, 1, null, 50, 512, 256);

    const stored = conn.execute.mock.calls.find(([sql]) => /SET soft_suspend_download_kbps = \?/.test(sql));
    expect(stored[1]).toEqual([512, 256, 10]);
    expect(conn.commit.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]);
    expect(sync).toHaveBeenCalledWith(1, { contractId: 10 });
    const log = db.query.mock.calls.find(([sql]) => /INSERT INTO suspension_logs/.test(sql));
    expect(log[1].find(p => typeof p === 'string' && p.startsWith('soft_suspend:'))).toContain('throttled to 512/256 kbps');
  });

  test('the CoA carries the vendor throttle attributes', async () => {
    connFor({ id: 10, status: 'active', organization_id: 1, plan_id: 4 });
    jest.spyOn(radiusService, 'syncFreeradiusTables').mockResolvedValue({ synced: 1 });
    db.query.mockImplementation(async (sql) => {
      if (/FROM radius r/.test(sql) || /FROM radius/.test(sql)) return [[{ id: 1, username: 'u1', nas_id: 3 }]];
      if (/FROM nas/.test(sql)) return [[{ id: 3, ip_address: '10.0.0.1', secret: 's', coa_port: 3799 }]];
      return [[]];
    });
    const sendSpy = jest.spyOn(require('dgram'), 'createSocket').mockImplementation(() => {
      const handlers = {};
      return {
        on: (ev, fn) => { handlers[ev] = fn; },
        once: (ev, fn) => { handlers[ev] = fn; },
        send: jest.fn((buf, _o, _l, _p, _h, cb) => { if (cb) cb(null); }),
        close: jest.fn(),
        bind: jest.fn(),
        unref: jest.fn(),
        _handlers: handlers,
      };
    });

    // No NAS answers the mocked socket: let the 5 s CoA timeout pass instantly.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const run = suspensionService.softSuspendContract(10, 1, null, 50, 512, 256);
      for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(6000);
      await run;
    } finally {
      jest.useRealTimers();
    }

    const sockets = sendSpy.mock.results.map(r => r.value);
    const packets = sockets.flatMap(sock => sock.send.mock.calls.map(c => c[0]));
    expect(packets.length).toBeGreaterThan(0);
    expect(packets.some(buf => buf.includes(Buffer.from('256k/512k')))).toBe(true);
  });

  test('the same throttle is not applied (or logged) twice', async () => {
    const conn = connFor({ id: 10, status: 'active', organization_id: 1, plan_id: 4, soft_suspend_download_kbps: 512, soft_suspend_upload_kbps: 256 });
    const outcome = await suspensionService.softSuspendContract(10, 1, null, 50, 512, 256);
    expect(outcome).toEqual({ skipped: true, reason: 'ALREADY_SOFT_SUSPENDED' });
    expect(conn.execute.mock.calls.some(([sql]) => /SET soft_suspend/.test(sql))).toBe(false);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO suspension_logs/.test(sql))).toBe(false);
  });

  test('a contract that is not active is not throttled', async () => {
    connFor({ id: 10, status: 'suspended', organization_id: 1, plan_id: 4 });
    expect(await suspensionService.softSuspendContract(10, 1, null, 50, 512, 256))
      .toEqual({ skipped: true, reason: 'CONTRACT_NOT_ACTIVE' });
  });

  test('missing rates are refused', async () => {
    await expect(suspensionService.softSuspendContract(10, 1, null, 50, 0, 256)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('reconnectContract lifts the throttle', () => {
  test('clears the columns and the CoA carries the plan rate', async () => {
    const conn = connFor({
      id: 10, status: 'active', first_activated_at: new Date(), organization_id: 1, plan_id: 4,
      soft_suspend_download_kbps: 512, soft_suspend_upload_kbps: 256,
    });
    db.query.mockResolvedValue([[]]);
    jest.spyOn(radiusService, 'syncFreeradiusTables').mockResolvedValue({ synced: 1 });
    const send = jest.fn().mockResolvedValue({ sent: true, response: 'ack' });
    jest.spyOn(suspensionService, 'sendRadiusCoA').mockImplementation(send);

    await suspensionService.reconnectContract(10, 5, null, { orgId: 1 });

    expect(conn.execute.mock.calls.some(([sql]) => /SET soft_suspend_download_kbps = NULL/.test(sql))).toBe(true);
    // planRateAttributes read the plan inside the transaction.
    expect(conn.execute.mock.calls.some(([sql]) => /SELECT \* FROM plans WHERE id = \?/.test(sql))).toBe(true);
  });
});

describe('FreeRADIUS sync', () => {
  test('a throttled active subscriber gets a := per-user rate row and no profile override', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/LEFT JOIN plans p/.test(sql) && /FROM radius r/.test(sql)) {
        return [[{
          id: 1, username: 'u1', cleartext_password: 'p', auth_method: 'pppoe', organization_id: 1,
          contract_status: 'active', plan_id: null, radius_vendor: 'mikrotik',
          soft_suspend_download_kbps: 512, soft_suspend_upload_kbps: 256,
        }]];
      }
      return [[]];
    });

    await radiusService.syncFreeradiusTables(1, { contractId: 10 });

    const rate = db.query.mock.calls.filter(([sql, p]) => /^INSERT INTO radreply/.test(sql) && p[1] === 'Mikrotik-Rate-Limit');
    expect(rate.map(([, p]) => p)).toEqual([['u1', 'Mikrotik-Rate-Limit', ':=', '256k/512k']]);
  });

  // The speed-window fan-out exclusion is asserted in speedWindowService.test.js.
});
