// =============================================================================
// VigaBSS 5.0 — FUP Service Tests
// =============================================================================
// ASY-36: check_fup_thresholds was a deferred stub because applyFupThrottle
// had no idempotency guard and its CoA carried no rate attributes (a */15
// cron would have re-throttled and re-logged every over-cap contract every
// tick, and nothing kept the throttle across a reconnect). The throttle is now
// contracts.fup_throttled_month, set and cleared by conditional UPDATEs.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/radiusService', () => ({
  changeOfAuth: jest.fn(),
  syncFreeradiusTables: jest.fn(async () => ({ synced: 1 })),
}));
jest.mock('../src/services/fupNotificationService', () => ({ monthUsage: jest.fn() }));
jest.mock('../src/utils/businessDate', () => ({
  ...jest.requireActual('../src/utils/businessDate'),
  businessToday: () => '2026-11-03',
}));

const db = require('../src/config/database');
const radiusService = require('../src/services/radiusService');
const { monthUsage } = require('../src/services/fupNotificationService');
const { applyFupThrottle, restoreFupSpeeds, checkFupThresholds, thresholdGb } = require('../src/services/fupService');

const PLAN = {
  fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1, radius_vendor: 'mikrotik',
  download_speed_mbps: 50, upload_speed_mbps: 10,
};
let contract;
let throttledMonth;

async function base(sql, params = []) {
  if (/FROM contracts c\s+JOIN plans p ON p.id = c.plan_id\s+WHERE c.id = \? AND c.organization_id = \?/.test(sql)) {
    return [contract && params[1] === contract.organization_id ? [{ ...contract, fup_throttled_month: throttledMonth }] : []];
  }
  if (/UPDATE contracts SET fup_throttled_month = \?/.test(sql)) {
    const [month] = params;
    if (throttledMonth && throttledMonth >= month) return [{ affectedRows: 0 }];
    throttledMonth = month;
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE contracts SET fup_throttled_month = NULL/.test(sql)) {
    if (!throttledMonth) return [{ affectedRows: 0 }];
    throttledMonth = null;
    return [{ affectedRows: 1 }];
  }
  if (/INSERT INTO plan_throttle_logs/.test(sql)) return [{ insertId: 42 }];
  return [[]];
}

const logs = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO plan_throttle_logs/.test(sql)).map(([, p]) => p);

beforeEach(() => {
  jest.clearAllMocks();
  contract = { contract_id: 1, organization_id: 10, status: 'active', ...PLAN };
  throttledMonth = null;
  db.query.mockImplementation(base);
  radiusService.changeOfAuth.mockResolvedValue({ sent: true, response: 'CoA-ACK', outcome: 'ack' });
});

describe('applyFupThrottle()', () => {
  it('records the month, sends the FUP rate in the CoA and logs once', async () => {
    const result = await applyFupThrottle(1, 10, '2026-11-01');
    expect(result).toMatchObject({ applied: true, coa_sent: true, log_id: 42, throttle_download_mbps: 5, throttle_upload_mbps: 1 });
    expect(throttledMonth).toBe('2026-11-01');
    // MikroTik rx/tx from the router's side: upload first, in kbps.
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(1, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '1000k/5000k' }]);
    expect(logs()).toEqual([[10, 1, 5, 1, 1, expect.any(String)]]);
    // FreeRADIUS gets the per-user throttle row, so a reconnect stays throttled.
    expect(radiusService.syncFreeradiusTables).toHaveBeenCalledWith(10, { contractId: 1 });
  });

  it('is idempotent: a second run in the same month sends and logs nothing', async () => {
    await applyFupThrottle(1, 10, '2026-11-01');
    const again = await applyFupThrottle(1, 10, '2026-11-01');
    expect(again).toEqual({ applied: false, already: true });
    expect(radiusService.changeOfAuth).toHaveBeenCalledTimes(1);
    expect(logs()).toHaveLength(1);
  });

  it('records coa_sent=false when the CoA is not acknowledged (NAK/timeout)', async () => {
    radiusService.changeOfAuth.mockResolvedValueOnce({ sent: false, response: 'CoA-NAK', outcome: 'nak' });
    const result = await applyFupThrottle(1, 10, '2026-11-01');
    expect(result).toMatchObject({ applied: true, coa_sent: false });
  });

  it('logs throttle even when CoA fails; the stored month still throttles the next login', async () => {
    radiusService.changeOfAuth.mockRejectedValueOnce(new Error('CoA timeout'));
    const result = await applyFupThrottle(1, 10, '2026-11-01');
    expect(result).toMatchObject({ applied: true, coa_sent: false, log_id: 42 });
    expect(throttledMonth).toBe('2026-11-01');
  });

  it('leaves a soft-suspended session at its suspension throttle', async () => {
    contract = { ...contract, soft_suspend_download_kbps: 128, soft_suspend_upload_kbps: 128 };
    const result = await applyFupThrottle(1, 10, '2026-11-01');
    expect(result).toMatchObject({ applied: true, coa_sent: false });
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
  });

  it('does nothing for a plan without FUP speeds, or a contract of another organization', async () => {
    contract = { ...contract, fup_download_speed_mbps: null };
    expect((await applyFupThrottle(1, 10)).applied).toBe(false);
    contract = { ...contract, fup_download_speed_mbps: 5 };
    expect(await applyFupThrottle(1, 11)).toMatchObject({ applied: false, message: 'Contract not found' });
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
  });
});

describe('restoreFupSpeeds()', () => {
  it('clears the month and sends the plan rate', async () => {
    throttledMonth = '2026-10-01';
    const result = await restoreFupSpeeds(1, 10);
    expect(result).toMatchObject({ restored: true, coa_sent: true, log_id: 42 });
    expect(throttledMonth).toBeNull();
    // The plan's own rate (generateAttributes, bursts included), not the FUP one.
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(1, 'update', [{ name: 'Mikrotik-Rate-Limit', value: expect.stringMatching(/^10M\/50M /) }]);
  });

  it('does nothing for a contract that is not throttled', async () => {
    expect(await restoreFupSpeeds(1, 10)).toMatchObject({ restored: false });
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
    expect(logs()).toEqual([]);
  });

  it('logs restore even when CoA fails', async () => {
    throttledMonth = '2026-10-01';
    radiusService.changeOfAuth.mockRejectedValueOnce(new Error('CoA timeout'));
    const result = await restoreFupSpeeds(1, 10);
    expect(result).toMatchObject({ restored: true, coa_sent: false });
  });
});

describe('checkFupThresholds()', () => {
  const PLAN_ROW = { data_cap_gb: '100.00', fup_threshold_gb: null, fup_threshold_percent: null };

  function sweep({ expired = [], contracts = [] }) {
    db.query.mockImplementation(async (sql, params) => {
      if (/fup_throttled_month < \?/.test(sql) && /SELECT id FROM contracts/.test(sql)) return [expired.map(id => ({ id }))];
      if (/AS fup_throttle_active/.test(sql)) return [contracts];
      return base(sql, params);
    });
  }

  it('throttles a contract over its threshold and leaves one under it alone', async () => {
    sweep({ contracts: [
      { id: 1, organization_id: 10, fup_throttle_active: 0, ...PLAN_ROW },
      { id: 2, organization_id: 10, fup_throttle_active: 0, ...PLAN_ROW },
    ] });
    monthUsage.mockImplementation(async c => (c.id === 1 ? { usedGb: 101, extraGb: 0 } : { usedGb: 40, extraGb: 0 }));
    const summary = await checkFupThresholds(10);
    expect(summary).toEqual({ checked: 2, throttled: 1, restored: 0, uncertain: 0 });
    expect(monthUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '2026-11-01', '2026-11-30');
    expect(throttledMonth).toBe('2026-11-01');
  });

  it('a data pack that lifts the allowance restores a throttled contract', async () => {
    throttledMonth = '2026-11-01';
    sweep({ contracts: [{ id: 1, organization_id: 10, fup_throttle_active: 1, ...PLAN_ROW }] });
    monthUsage.mockResolvedValue({ usedGb: 101, extraGb: 20 });
    expect(await checkFupThresholds(10)).toMatchObject({ throttled: 0, restored: 1 });
    expect(throttledMonth).toBeNull();
  });

  it('restores last month\'s throttles at the start of a month', async () => {
    throttledMonth = '2026-10-01';
    sweep({ expired: [1], contracts: [] });
    expect(await checkFupThresholds(10)).toMatchObject({ restored: 1 });
    expect(throttledMonth).toBeNull();
  });

  it('never throttles from untrustworthy counters', async () => {
    sweep({ contracts: [{ id: 1, organization_id: 10, fup_throttle_active: 0, ...PLAN_ROW }] });
    monthUsage.mockResolvedValue(null);
    expect(await checkFupThresholds(10)).toMatchObject({ throttled: 0, uncertain: 1 });
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
  });
});

test('thresholdGb: explicit GB, else a percent of the cap, else the cap', () => {
  expect(thresholdGb({ fup_threshold_gb: '80', data_cap_gb: '100' })).toBe(80);
  expect(thresholdGb({ fup_threshold_percent: 90, data_cap_gb: '100' })).toBe(90);
  expect(thresholdGb({ data_cap_gb: '100' })).toBe(100);
  expect(thresholdGb({})).toBe(0);
});
