// =============================================================================
// REG-03 — accounting evidence is kept while its session is kept
// =============================================================================
// radius_accounting_events were purged by each row's own event_at, while
// connection_logs is kept by retention_at (its last activity). Only milestones
// are stored (Start, the first Interim, Stop). For a session from 2026-01-01 to
// 2026-07-01, the Start was deleted around 2028-01-01, so a 2028-02-15 lookup of
// 2026-06-15 (inside the 24-month window) said 'unavailable' while the session
// row and its Stop were still kept.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => m) };
  return m;
});

const db = require('../src/config/database');
const retentionService = require('../src/services/retentionService');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([{ affectedRows: 0 }]);
});

test('the purge keeps events whose session row is still kept', async () => {
  await retentionService.purgeTableMonths('radius_accounting_events', 24, { organizationId: 1 });
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/^DELETE FROM `radius_accounting_events` WHERE `event_at` < DATE_SUB\(NOW\(\), INTERVAL \? MONTH\)/);
  expect(sql).toMatch(/NOT EXISTS \(\s*-- Kept while its session is \(REG-03\)[\s\S]*SELECT 1 FROM connection_logs owning\s+WHERE owning\.organization_id = radius_accounting_events\.organization_id\s+AND \(owning\.id = radius_accounting_events\.connection_log_id\s+OR \(radius_accounting_events\.session_instance_id IS NOT NULL\s+AND owning\.session_instance_id = radius_accounting_events\.session_instance_id\)\)/);
  expect(params).toEqual([24, 1]);
});

test('the session rows themselves still go by their last activity', async () => {
  await retentionService.purgeTableMonths('connection_logs', 24, { organizationId: 1 });
  const [sql] = db.query.mock.calls[0];
  expect(sql).toMatch(/^DELETE FROM `connection_logs` WHERE `retention_at` < /);
  expect(sql).not.toMatch(/FROM connection_logs owning/);
});
