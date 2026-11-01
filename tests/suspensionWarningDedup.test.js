// =============================================================================
// ASY-19 / DAL-06 — a suspension warning is sent once, and only for live rules
// =============================================================================
// runSuspensionWarnings kept no record of what it sent and ran from both the
// billing_cycle (02:00) and the superseded auto_suspend_overdue (06:00) tasks,
// so a subscriber in a rule's warning window got the same email twice a day
// until they paid. It also read rules without the soft-delete filter, so a
// deleted rule kept warning about a suspension that never runs.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn() }));

const db = require('../src/config/database');
const emailTransport = require('../src/services/emailTransport');
const taskRunner = require('../src/services/taskRunner');

const RULES = [
  { id: 1, org_id: 42, organization_id: 42, days_past_due: 30, notify_before_days: 7, action: 'auto_suspend', is_active: 1, deleted_at: null },
  { id: 2, org_id: 42, organization_id: 42, days_past_due: 31, notify_before_days: 7, action: 'soft_suspend', is_active: 1, deleted_at: null },
  { id: 3, org_id: 42, organization_id: 42, days_past_due: 30, notify_before_days: 7, action: 'auto_suspend', is_active: 1, deleted_at: '2026-10-01' },
];
const CONTRACT = {
  id: 10, client_id: 50, organization_id: 42, invoice_id: 500, invoice_number: 'INV-10',
  total: '580.00', currency: 'MXN', due_date: '2026-10-01', days_overdue: 26,
};

let sentLog;
let rules;
beforeEach(() => {
  jest.clearAllMocks();
  sentLog = new Set();
  rules = RULES.slice(0, 1);
  emailTransport.sendEmail.mockResolvedValue({ success: true });
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM suspension_rules sr/.test(sql)) {
      return [rules.filter((r) => !/sr\.deleted_at IS NULL/.test(sql) || !r.deleted_at)];
    }
    if (/FROM contracts c/.test(sql)) return [[CONTRACT]];
    if (/FROM clients cl/.test(sql)) return [[{ name: 'Ana', email: 'ana@example.com', org_name: 'ISP' }]];
    if (/INSERT IGNORE INTO suspension_warning_logs/.test(sql)) {
      const key = params.slice(1).join(':');
      if (sentLog.has(key)) return [{ affectedRows: 0 }];
      sentLog.add(key);
      return [{ affectedRows: 1 }];
    }
    if (/DELETE FROM suspension_warning_logs/.test(sql)) {
      sentLog.delete(params.join(':'));
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
});

test('billing_cycle and auto_suspend_overdue on the same day send one warning', async () => {
  const first = await taskRunner.runSuspensionWarnings(42);
  const second = await taskRunner.runSuspensionWarnings(42);
  expect(first.warnings_sent).toBe(1);
  expect(second.warnings_sent).toBe(0);
  expect(emailTransport.sendEmail).toHaveBeenCalledTimes(1);
});

test('two rules whose windows hold the contract send one warning per run', async () => {
  rules = RULES.slice(0, 2);
  const result = await taskRunner.runSuspensionWarnings(42);
  expect(result.warnings_sent).toBe(1);
  expect(emailTransport.sendEmail).toHaveBeenCalledTimes(1);
});

test('a failed send is retried on the next run', async () => {
  emailTransport.sendEmail.mockResolvedValueOnce({ success: false, error: 'SMTP down' });
  expect((await taskRunner.runSuspensionWarnings(42)).warnings_sent).toBe(0);
  expect((await taskRunner.runSuspensionWarnings(42)).warnings_sent).toBe(1);
  expect(emailTransport.sendEmail).toHaveBeenCalledTimes(2);
});

test('a deleted rule sends no warning (DAL-06)', async () => {
  rules = [RULES[2]];
  const result = await taskRunner.runSuspensionWarnings(42);
  expect(result.warnings_sent).toBe(0);
  expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  const candidates = db.query.mock.calls.filter(([sql]) => /FROM contracts c/.test(sql));
  expect(candidates).toHaveLength(0);
});

test('the warning candidates exclude deleted contracts and invoices (DAL-06)', async () => {
  await taskRunner.runSuspensionWarnings(42);
  const [sql] = db.query.mock.calls.find(([q]) => /FROM contracts c/.test(q));
  expect(sql).toMatch(/c\.deleted_at IS NULL/);
  expect(sql).toMatch(/i\.deleted_at IS NULL/);
});

test('migration 489 disables the superseded tasks only where billing_cycle runs', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '489_suspension_warning_dedup.sql'), 'utf8');
  expect(sql).toMatch(/task_name IN \('auto_generate_invoices', 'auto_suspend_overdue'\)/);
  expect(sql).toMatch(/task_name = 'billing_cycle' AND organization_id IS NULL AND is_enabled = TRUE/);
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  for (const task of ['auto_generate_invoices', 'auto_suspend_overdue']) {
    const seed = schema.slice(schema.indexOf(`(NULL, '${task}'`)).split('),')[0];
    expect(seed).toMatch(/FALSE$/);
  }
});
