// =============================================================================
// TNA-41 — batch jobs run in the background from persisted items
// =============================================================================
// createBatchJob ran every target inside the HTTP request (up to 1000, each
// suspend sending a CoA that can wait 5 s), and POST /bulk/suspend did the
// same for 500 contracts: both outlived the 30-second request timeout, and a
// restart lost the rest. Jobs are now persisted item by item, queued, run
// under an advisory lock, and resumed at startup; an item interrupted
// mid-operation becomes a failure to check by hand instead of running twice.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withPrimaryContext: fn => fn(),
  withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/suspensionService', () => ({
  suspendContract: jest.fn(async () => ({ suspended: true })),
  reconnectContract: jest.fn(),
}));
const mockLock = { free: true };
jest.mock('../src/utils/advisoryLock', () => ({
  withAdvisoryLock: jest.fn(async (_key, fn) => {
    if (!mockLock.free) return false;
    await fn();
    return true;
  }),
}));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn(async () => ({ status: 'queued' })) }));
jest.mock('../src/services/organizationFanOut', () => ({
  forEachDatabaseScope: async (_label, handler) => handler(null),
  orgScopeFilter: () => ({ sql: '', params: [] }),
}));

const db = require('../src/config/database');
const suspension = require('../src/services/suspensionService');
const jobQueue = require('../src/services/jobQueueService');
const automation = require('../src/services/automationService');

// ---------------------------------------------------------------------------
// In-memory batch_jobs / batch_job_items / contracts
// ---------------------------------------------------------------------------
let jobs;
let items;
let contracts;

function fake(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith('INSERT INTO batch_jobs')) {
    const id = jobs.length + 1;
    jobs.push({ id, organization_id: params[0], name: params[1], operation: params[2], operation_params: params[4],
      status: 'pending', total_items: params[5], processed_items: 0, success_items: 0, failed_items: 0, created_by: params[6] });
    return [{ insertId: id }];
  }
  if (s.startsWith('INSERT INTO batch_job_items')) {
    for (let i = 0; i < params.length; i += 4) {
      items.push({ id: items.length + 1, batch_job_id: params[i], organization_id: params[i + 1],
        entity_type: params[i + 2], entity_id: params[i + 3], status: 'pending', result_message: null });
    }
    return [{ affectedRows: params.length / 4 }];
  }
  if (s.startsWith('SELECT * FROM batch_jobs')) return [jobs.filter(j => j.id === params[0]).map(j => ({ ...j }))];
  if (s.startsWith("UPDATE batch_jobs SET status = 'running'")) {
    const j = jobs.find(x => x.id === params[0] && ['pending', 'running'].includes(x.status));
    if (j) j.status = 'running';
    return [{ affectedRows: j ? 1 : 0 }];
  }
  if (s.startsWith("UPDATE batch_job_items SET status = 'failure'")) {
    let n = 0;
    for (const it of items) if (it.batch_job_id === params[0] && it.status === 'processing') { it.status = 'failure'; it.result_message = 'Interrupted while running; check this one by hand'; n += 1; }
    return [{ affectedRows: n }];
  }
  if (s.startsWith('SELECT status FROM batch_jobs')) return [[{ status: jobs.find(j => j.id === params[0])?.status }]];
  if (s.startsWith('SELECT id, entity_type, entity_id FROM batch_job_items')) {
    return [items.filter(it => it.batch_job_id === params[0] && it.status === 'pending').slice(0, 100).map(it => ({ ...it }))];
  }
  if (s.startsWith("UPDATE batch_job_items SET status = 'processing'")) {
    const it = items.find(x => x.id === params[0] && x.status === 'pending');
    if (it) it.status = 'processing';
    return [{ affectedRows: it ? 1 : 0 }];
  }
  if (s.startsWith('UPDATE batch_job_items SET status = ?')) {
    const it = items.find(x => x.id === params[2]);
    Object.assign(it, { status: params[0], result_message: params[1] });
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith('UPDATE batch_jobs bj JOIN')) {
    const j = jobs.find(x => x.id === params[1]);
    const mine = items.filter(it => it.batch_job_id === params[0]);
    j.processed_items = mine.filter(it => ['success', 'failure', 'skipped'].includes(it.status)).length;
    j.success_items = mine.filter(it => it.status === 'success').length;
    j.failed_items = mine.filter(it => it.status === 'failure').length;
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE batch_jobs SET status = 'completed'")) {
    const j = jobs.find(x => x.id === params[0] && x.status === 'running');
    if (j) j.status = 'completed';
    return [{ affectedRows: j ? 1 : 0 }];
  }
  if (s.startsWith('SELECT id, status FROM contracts')) {
    return [contracts.filter(c => c.id === params[0] && c.organization_id === params[1])];
  }
  if (s.startsWith('SELECT id, organization_id FROM batch_jobs')) {
    return [jobs.filter(j => ['pending', 'running'].includes(j.status)).map(j => ({ id: j.id, organization_id: j.organization_id }))];
  }
  if (/FROM contracts c WHERE/.test(s)) return [contracts.filter(c => c.organization_id === params[0]).map(c => ({ entity_id: c.id, entity_type: 'contract' }))];
  throw new Error(`Unexpected SQL: ${s.slice(0, 100)}`);
}

beforeEach(() => {
  jobs = [];
  items = [];
  contracts = [
    { id: 10, organization_id: 1, status: 'active' },
    { id: 11, organization_id: 1, status: 'suspended' },
    { id: 12, organization_id: 1, status: 'pending' },
    { id: 13, organization_id: 1, status: 'active' },
    { id: 50, organization_id: 2, status: 'active' }, // another organization's
  ];
  mockLock.free = true;
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => fake(sql, params));
  suspension.suspendContract.mockReset();
  suspension.suspendContract.mockImplementation(async id => (id === 13 ? { skipped: true, reason: 'VIP' } : { suspended: true }));
  jobQueue.add.mockClear();
});

const create = (contractIds) => automation.createBatchJob(1, {
  name: 'Bulk suspend', operation: 'suspend', filter_criteria: { contract_ids: contractIds }, created_by: 7,
});

test('creating a job persists one pending item per target, queues it and runs nothing', async () => {
  const job = await create([10, 11, 12, 13, 50, 999]);

  expect(job).toMatchObject({ status: 'pending', total_items: 6 });
  expect(items.map(i => i.entity_id)).toEqual([10, 11, 12, 13, 50, 999]);
  expect(items.every(i => i.status === 'pending')).toBe(true);
  expect(jobQueue.add).toHaveBeenCalledWith('batch-job', { jobId: job.id, organizationId: 1 }, expect.objectContaining({ jobId: `batch-job-${job.id}` }));
  expect(suspension.suspendContract).not.toHaveBeenCalled();
});

test('the job applies each item with the per-contract checks the bulk route had', async () => {
  const job = await create([10, 11, 12, 13, 50, 999]);
  await automation.processBatchJob(job.id, 1);

  const byId = Object.fromEntries(items.map(i => [i.entity_id, i]));
  expect(byId[10]).toMatchObject({ status: 'success' });
  expect(byId[11]).toMatchObject({ status: 'failure', result_message: "Cannot suspend a 'suspended' contract" });
  expect(byId[12]).toMatchObject({ status: 'failure', result_message: "Cannot suspend a 'pending' contract" });
  expect(byId[13]).toMatchObject({ status: 'failure', result_message: 'Suspension-exempt client: VIP' });
  // Another organization's contract, and one that does not exist.
  expect(byId[50]).toMatchObject({ status: 'failure', result_message: 'Contract 50 not found in organization' });
  expect(byId[999]).toMatchObject({ status: 'failure', result_message: 'Contract 999 not found in organization' });
  // Through suspensionService (CoA, radius status, exemption), as the creator.
  expect(suspension.suspendContract).toHaveBeenCalledWith(10, null, 7, null);
  expect(suspension.suspendContract).not.toHaveBeenCalledWith(11, expect.anything(), expect.anything(), expect.anything());

  expect(jobs[0]).toMatchObject({ status: 'completed', processed_items: 6, success_items: 1, failed_items: 5 });
});

test('a resumed job does not run an item it may already have applied', async () => {
  const job = await create([10, 13]);
  items[0].status = 'processing'; // the process stopped mid-item
  jobs[0].status = 'running';

  await automation.processBatchJob(job.id, 1);

  expect(items[0]).toMatchObject({ status: 'failure', result_message: expect.stringMatching(/Interrupted/) });
  expect(suspension.suspendContract).not.toHaveBeenCalledWith(10, expect.anything(), expect.anything(), expect.anything());
  expect(suspension.suspendContract).toHaveBeenCalledWith(13, null, 7, null);
});

test('a job another process is running is left alone', async () => {
  const job = await create([10]);
  mockLock.free = false;
  await automation.processBatchJob(job.id, 1);
  expect(suspension.suspendContract).not.toHaveBeenCalled();
  expect(items[0].status).toBe('pending');
});

test('a cancelled job stops and keeps its status', async () => {
  const job = await create([10, 13]);
  jobs[0].status = 'cancelled';
  await automation.processBatchJob(job.id, 1);
  expect(suspension.suspendContract).not.toHaveBeenCalled();
  expect(jobs[0].status).toBe('cancelled');
});

test('unfinished jobs are queued again at startup', async () => {
  await create([10]);
  await create([13]);
  jobs[1].status = 'running';
  jobQueue.add.mockClear();

  await expect(automation.resumeBatchJobs()).resolves.toBe(2);
  expect(jobQueue.add.mock.calls.map(c => c[1].jobId)).toEqual([1, 2]);
});

test('more targets than the cap are refused, not cut short', async () => {
  contracts = Array.from({ length: 10_001 }, (_, i) => ({ id: i + 1, organization_id: 1, status: 'active' }));
  await expect(automation.createBatchJob(1, { name: 'All', operation: 'suspend', filter_criteria: {} }))
    .rejects.toThrow(/more than 10000/);
  expect(jobs).toHaveLength(0);
});

test('an unimplemented operation becomes a failure item, never a success', async () => {
  // createBatchJob refuses apply_tag now (ASY-36, batchMessages.test.js); a
  // job stored with it still fails its items rather than reporting success.
  jobs.push({ id: 1, organization_id: 1, name: 'Tags', operation: 'apply_tag', operation_params: null, status: 'pending',
    total_items: 1, processed_items: 0, success_items: 0, failed_items: 0, created_by: 7 });
  items.push({ id: 1, batch_job_id: 1, organization_id: 1, entity_type: 'contract', entity_id: 10, status: 'pending', result_message: null });
  const job = jobs[0];
  await automation.processBatchJob(job.id, 1);
  expect(items[0].status).toBe('failure');
  expect(jobs[0]).toMatchObject({ status: 'completed', success_items: 0, failed_items: 1 });
});
