// =============================================================================
// ASY-15 — batch jobs check their parameters, actor and cancellation
// =============================================================================
// change_plan wrote operation_params.plan_id onto every target with no plan
// check (another tenant's or an archived plan), suspend wrote the body's
// rule_id/user_id/invoice_id into the suspension log, and the job always ended
// 'completed', so cancel neither stopped the loop nor stuck.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const auditLog = require('../src/services/auditLog');
const automationService = require('../src/services/automationService');
const suspensionService = require('../src/services/suspensionService');

const job = (overrides = {}) => ({ name: 'b', filter_criteria: {}, created_by: 7, ...overrides });
const sqlRan = re => db.query.mock.calls.some(([sql]) => re.test(sql));

beforeEach(() => {
  db.query.mockReset();
  auditLog.log.mockClear();
});

test('change_plan to a plan this organization cannot select creates no job', async () => {
  db.query.mockResolvedValue([[]]);
  await expect(automationService.createBatchJob(1, job({ operation: 'change_plan', operation_params: { plan_id: 900 } })))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(sqlRan(/INSERT INTO batch_jobs/)).toBe(false);
  expect(sqlRan(/UPDATE contracts SET plan_id/)).toBe(false);
});

test('suspend with another tenant\'s invoice creates no job', async () => {
  db.query.mockResolvedValue([[]]);
  await expect(automationService.createBatchJob(1, job({ operation: 'suspend', operation_params: { invoice_id: 900 } })))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(sqlRan(/INSERT INTO batch_jobs/)).toBe(false);
});

test('batch suspend is attributed to the job creator, not body ids', async () => {
  const suspend = jest.spyOn(suspensionService, 'suspendContract').mockResolvedValue({});
  db.query.mockResolvedValueOnce([[{ id: 10, status: 'active' }]]);
  await automationService.applyBatchOperation(1, 'suspend', { entity_id: 10 }, { rule_id: 55, user_id: 99 }, 7);
  expect(suspend).toHaveBeenCalledWith(10, null, 7, null);
  suspend.mockRestore();
});

test('a batch plan change is audited', async () => {
  db.query
    .mockResolvedValueOnce([[{ id: 10, plan_id: 3 }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }]);
  await automationService.applyBatchOperation(1, 'change_plan', { entity_id: 10 }, { plan_id: 4 }, 7);
  expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
    userId: 7, organizationId: 1, tableName: 'contracts', recordId: 10,
    oldValues: { plan_id: 3 }, newValues: { plan_id: 4 },
  }));
});

// The job runs in the background now (TNA-41); cancellation between chunks
// and the 'running'-only completion are covered by batchJobsBackground.test.js.
test('creating a job only persists it: no item runs inside the request', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/^SELECT id AS entity_id/.test(sql.trim())) return [[{ entity_id: 10, entity_type: 'contract' }, { entity_id: 11, entity_type: 'contract' }]];
    if (/INSERT INTO batch_jobs/.test(sql)) return [{ insertId: 1 }];
    if (/^\s*(INSERT|UPDATE)/.test(sql)) return [{ affectedRows: 1 }];
    return [[{ id: 1, status: 'pending' }]];
  });
  await automationService.createBatchJob(1, job({ operation: 'rate_limit' }));
  expect(sqlRan(/INSERT INTO batch_job_items/)).toBe(true);
  expect(sqlRan(/SET status = 'processing'/)).toBe(false);
  expect(sqlRan(/SET status = 'completed'/)).toBe(false);
});
