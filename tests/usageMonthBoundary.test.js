// =============================================================================
// REG-02 — a session online across the 1st keeps both months billable
// =============================================================================
// A 5-minute Interim from 2026-10-31T23:57Z to 2026-11-01T00:02Z wrote a
// zero-delta 10-31 row and the 11-01 delta row, both is_complete = 0. Per-GB
// overage, FUP notices and rollover all refuse an incomplete month, so for
// nearly every always-on PPPoE line none of them ever applied, with no warning.
// The interval is now split pro rata, as a labeled estimate, and stays complete.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const { calculateUsageDelta, recordUsageDelta, splitAtMonthStart } = require('../src/services/radiusAccountingService');

const PREV = new Date('2026-10-31T23:57:00Z');
const NOW = new Date('2026-11-01T00:02:00Z');

test('the interval is split by the time on each side of the 1st', () => {
  const { before, after } = splitAtMonthStart({ bytesIn: 1000, bytesOut: 501, packetsIn: 10, packetsOut: 0, duration: 300 }, PREV, NOW);
  // 3 of the 5 minutes fall in October.
  expect(before).toEqual({ bytesIn: 600, bytesOut: 300, packetsIn: 6, packetsOut: 0, duration: 180 });
  expect(after).toEqual({ bytesIn: 400, bytesOut: 201, packetsIn: 4, packetsOut: 0, duration: 120 });
});

test('both months get a complete row with their share', async () => {
  const usage = calculateUsageDelta({
    previous: { bytesIn: 5000, bytesOut: 5000, packetsIn: 0, packetsOut: 0, duration: 0 },
    current: { bytesIn: 6000, bytesOut: 5500, packetsIn: 0, packetsOut: 0, duration: 300 },
    previousEventAt: PREV,
    eventAt: NOW,
    priorComplete: true,
  });
  expect(usage.rowComplete).toBe(true);

  const execute = jest.fn().mockResolvedValue([{ affectedRows: 1 }]);
  await recordUsageDelta({ execute }, {
    organizationId: 1, sessionInstanceId: '00000000-0000-4000-8000-000000000001', connectionLogId: 9,
    contractId: 3, clientId: 4, nasId: 5, username: 'u', eventAt: NOW, usage,
  });

  const rows = execute.mock.calls.map(([, p]) => ({
    usage_date: p[1], bytes_in: p[8], bytes_out: p[9], is_complete: p[13], reason: p[15],
  }));
  expect(rows).toEqual([
    { usage_date: '2026-10-31', bytes_in: 600, bytes_out: 300, is_complete: 1, reason: 'utc_month_boundary_estimate' },
    { usage_date: '2026-11-01', bytes_in: 400, bytes_out: 200, is_complete: 1, reason: 'utc_month_boundary_estimate' },
  ]);
  // Nothing lost or added across the split.
  expect(rows[0].bytes_in + rows[1].bytes_in).toBe(1000);
});

test('a counter reset still makes the period incomplete', () => {
  const usage = calculateUsageDelta({
    previous: { bytesIn: 6000, bytesOut: 5500 },
    current: { bytesIn: 10, bytesOut: 10 },
    previousEventAt: PREV,
    eventAt: NOW,
    priorComplete: true,
  });
  expect(usage).toMatchObject({ rowComplete: false, anomalyReason: 'counter_reset' });
});
