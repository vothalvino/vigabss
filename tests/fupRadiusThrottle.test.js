// =============================================================================
// ASY-36 — RADIUS serves the FUP rate while a contract is FUP-throttled
// =============================================================================
// The old FUP CoA carried no rate attributes and nothing was stored, so even
// a delivered CoA was undone by the next login. Both RADIUS paths now serve
// the plan's FUP speeds while contracts.fup_throttled_month names the current
// month; a soft suspension's own throttle still wins.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const { effectiveThrottle, fupThrottleActiveSql } = require('../src/services/radiusAttributeService');
const radiusService = require('../src/services/radiusService');
const { buildAcceptAttributes } = require('../src/services/radiusServerService');

const PLAN = {
  id: 4, radius_vendor: 'mikrotik', download_speed_mbps: 50, upload_speed_mbps: 10,
  fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1,
};

beforeEach(() => { jest.clearAllMocks(); });

describe('effectiveThrottle', () => {
  test('the FUP rate in kbps while throttled this month', () => {
    expect(effectiveThrottle({ fup_throttle_active: 1, fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1 }))
      .toEqual({ downloadKbps: 5000, uploadKbps: 1000, reason: 'fup' });
  });
  test('a soft suspension wins', () => {
    expect(effectiveThrottle({
      fup_throttle_active: 1, fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1,
      soft_suspend_download_kbps: 512, soft_suspend_upload_kbps: 256,
    })).toMatchObject({ downloadKbps: 512, reason: 'soft_suspend' });
  });
  test('none when not throttled, or the plan has no FUP speeds', () => {
    expect(effectiveThrottle({ fup_throttle_active: 0, fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1 })).toBeNull();
    expect(effectiveThrottle({ fup_throttle_active: 1, fup_download_speed_mbps: null, fup_upload_speed_mbps: 1 })).toBeNull();
  });
  test('the SQL flag compares the stored month with the current business month', () => {
    expect(fupThrottleActiveSql('c')).toMatch(/^\(c\.fup_throttled_month IS NOT NULL AND c\.fup_throttled_month >= DATE_FORMAT\(DATE\('\d{4}-\d{2}-\d{2}'\), '%Y-%m-01'\)\)$/);
  });
});

describe('embedded RADIUS server', () => {
  const accept = sub => buildAcceptAttributes({ contract_status: 'active', ...sub }, PLAN, false);

  test('an FUP-throttled subscriber gets the FUP rate', () => {
    expect(accept({ fup_throttle_active: 1 }).includes(Buffer.from('1000k/5000k'))).toBe(true);
  });

  test('an unthrottled subscriber gets the plan rate', () => {
    const packet = accept({ fup_throttle_active: 0 });
    expect(packet.includes(Buffer.from('1000k/5000k'))).toBe(false);
    expect(packet.includes(Buffer.from('10M/50M'))).toBe(true);
  });
});

describe('FreeRADIUS sync', () => {
  test('selects the FUP state and writes the FUP rate as a := per-user row', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/LEFT JOIN plans p/.test(sql) && /FROM radius r/.test(sql)) {
        return [[{
          id: 1, username: 'u1', cleartext_password: 'p', auth_method: 'pppoe', organization_id: 1,
          contract_status: 'active', plan_id: null, radius_vendor: 'mikrotik',
          fup_throttle_active: 1, fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1,
        }]];
      }
      return [[]];
    });

    await radiusService.syncFreeradiusTables(1, { contractId: 10 });

    const select = db.query.mock.calls.find(([sql]) => /LEFT JOIN plans p/.test(sql) && /FROM radius r/.test(sql))[0];
    expect(select).toMatch(/fup_throttled_month .* AS fup_throttle_active/s);
    const rate = db.query.mock.calls.filter(([sql, p]) => /^INSERT INTO radreply/.test(sql) && p[1] === 'Mikrotik-Rate-Limit');
    expect(rate.map(([, p]) => p)).toEqual([['u1', 'Mikrotik-Rate-Limit', ':=', '1000k/5000k']]);
  });
});
