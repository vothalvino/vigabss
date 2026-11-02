'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
// Data-pack and rollover GB (TNA-21) have their own tests; here they add
// nothing, so the positional db.query mocks below stay in step.
const mockExtraAllowance = jest.fn(async () => ({ pack_gb: 0, rollover_gb: 0, total_gb: 0 }));
jest.mock('../src/services/dataPackService', () => ({
  extraAllowanceGb: (...a) => mockExtraAllowance(...a),
}));
// Delivery (SUP-07): email by default; tests switch it to fail or fall back.
const mockSendEmail = jest.fn(async () => ({ success: true }));
const mockSendSms = jest.fn(async () => ({ success: true }));
const mockPush = jest.fn(async () => ({ sent: 0, failed: 0 }));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));
jest.mock('../src/services/smsTransport', () => ({ sendSms: (...a) => mockSendSms(...a) }));
jest.mock('../src/services/portalPushService', () => ({ dispatch: (...a) => mockPush(...a) }));
const fupNotificationService = require('../src/services/fupNotificationService');

describe('fupNotificationService', () => {
  beforeEach(() => jest.clearAllMocks());

  // TNA-21: 85 GB of a 100 GB plan plus a 20 GB pack is ~71%, no notice.
  it('a data pack raises the allowance the thresholds are measured against', async () => {
    mockExtraAllowance.mockResolvedValueOnce({ pack_gb: 20, rollover_gb: 0, total_gb: 20 });
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, client_id: 5, data_cap_gb: '100.000', fup_threshold_gb: null }]])
      .mockResolvedValueOnce([[{ used_gb: '85.000', observed_rows: 1, incomplete_rows: 0, unverifiable_session_rows: 0 }]]);

    const result = await fupNotificationService.checkAndNotifyThresholds(1);
    expect(result.notified).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('notifies at 80% threshold', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, client_id: 5, client_email: 'ana@x.mx',
        data_cap_gb: '100.000', fup_threshold_gb: null,
      }]])
      // usage: 85% — triggers 80% threshold only
      .mockResolvedValueOnce([[
        { used_gb: '85.000', observed_rows: 1, incomplete_rows: 0, unverifiable_session_rows: 0 },
      ]])
      // dedup check for 80% — not found
      .mockResolvedValueOnce([[null]])
      // insert notification
      .mockResolvedValueOnce([{ insertId: 1 }])
      // dedup check for 90% — 85 < 90, loop exits
    ;

    const result = await fupNotificationService.checkAndNotifyThresholds(1);
    expect(result.notified).toBe(1);
    expect(result.checked).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ clientId: 5, messageClass: 'transactional', to: 'ana@x.mx' }));
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO fup_usage_notifications/.test(sql));
    expect(insert[1][4]).toBe('email');
  });

  // SUP-07: a notice nothing delivered is not recorded or counted, so the
  // month is not marked as notified.
  it('records nothing when no channel delivers the notice', async () => {
    mockSendEmail.mockResolvedValueOnce({ success: false, error: 'smtp down' });
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, client_id: 5, client_email: 'ana@x.mx', data_cap_gb: '100.000', fup_threshold_gb: null }]])
      .mockResolvedValueOnce([[{ used_gb: '85.000', observed_rows: 1, incomplete_rows: 0, unverifiable_session_rows: 0 }]])
      .mockResolvedValueOnce([[null]]);
    const result = await fupNotificationService.checkAndNotifyThresholds(1);
    expect(result.notified).toBe(0);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO fup_usage_notifications/.test(sql))).toBe(false);
  });

  it('falls back to SMS and records the channel used', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 1, client_id: 5, client_email: null, client_phone: '+525512345678', data_cap_gb: '100.000', fup_threshold_gb: null }]])
      .mockResolvedValueOnce([[{ used_gb: '85.000', observed_rows: 1, incomplete_rows: 0, unverifiable_session_rows: 0 }]])
      .mockResolvedValueOnce([[null]])
      .mockResolvedValueOnce([{ insertId: 1 }]);
    await fupNotificationService.checkAndNotifyThresholds(1);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO fup_usage_notifications/.test(sql));
    expect(insert[1][4]).toBe('sms');
  });

  it('deduplicates notifications already sent this month', async () => {
    db.query
      .mockResolvedValueOnce([[{
        id: 1, organization_id: 1, client_id: 5,
        data_cap_gb: '100.000', fup_threshold_gb: null,
      }]])
      .mockResolvedValueOnce([[
        { used_gb: '85.000', observed_rows: 1, incomplete_rows: 0, unverifiable_session_rows: 0 },
      ]])
      // dedup check for 80% — ALREADY exists
      .mockResolvedValueOnce([[{ id: 10 }]])
    ;

    const result = await fupNotificationService.checkAndNotifyThresholds(1);
    expect(result.notified).toBe(0);
  });

  it('returns zero when no contracts with caps', async () => {
    db.query.mockResolvedValueOnce([[]]); // no contracts
    const result = await fupNotificationService.checkAndNotifyThresholds(1);
    expect(result.checked).toBe(0);
    expect(result.notified).toBe(0);
  });

  it('does not notify when a session is still awaiting its first follow-up', async () => {
    db.query
      .mockResolvedValueOnce([[
        { id: 1, organization_id: 1, client_id: 5, data_cap_gb: '100.000', fup_threshold_gb: null },
      ]])
      .mockResolvedValueOnce([[
        { used_gb: '95.000', observed_rows: 2, incomplete_rows: 0, unverifiable_session_rows: 1 },
      ]]);

    const result = await fupNotificationService.checkAndNotifyThresholds(1);

    expect(result).toEqual({ checked: 1, notified: 0 });
  });

  describe('listNotifications', () => {
    it('returns notifications for an org', async () => {
      db.query.mockResolvedValueOnce([[
        { id: 1, contract_id: 5, billing_month: '2026-06-01', threshold_pct: 80 },
      ]]);
      const rows = await fupNotificationService.listNotifications(1);
      expect(rows).toHaveLength(1);
    });
  });
});
