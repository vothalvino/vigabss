// =============================================================================
// NET-26 — AP commands run, or are refused; never stored to sit 'pending'
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getLockConnection: jest.fn() }));
jest.mock('../src/utils/advisoryLock', () => ({ withAdvisoryLock: jest.fn(async (_key, fn) => { await fn(); return true; }) }));
jest.mock('../src/services/routerDriverService', () => ({ dispatchCommand: jest.fn() }));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/wirelessService', () => ({ getApCommandJob: jest.fn(async id => ({ id, status: 'queued' })) }));

const db = require('../src/config/database');
const routerDriverService = require('../src/services/routerDriverService');
const jobQueue = require('../src/services/jobQueueService');
const svc = require('../src/services/apCommandService');

const ORG = 10;

function answer({ device = true, configs = [{ id: 3, vendor: 'mikrotik' }], job } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM devices/.test(sql)) return [device ? [{ id: 5 }] : []];
    if (/FROM router_driver_configs/.test(sql)) return [configs];
    if (/INSERT INTO ap_command_jobs/.test(sql)) return [{ insertId: 77 }];
    if (/SELECT \* FROM ap_command_jobs/.test(sql)) return [[job].filter(Boolean)];
    if (/SET status = 'in_progress'/.test(sql)) return [{ affectedRows: job && ['pending', 'queued'].includes(job.status) ? 1 : 0 }];
    return [{ affectedRows: 1 }];
  });
}

beforeEach(() => jest.clearAllMocks());

describe('createApCommandJob', () => {
  test.each(['set_tx_power', 'set_frequency', 'set_channel_width', 'other'])('%s has no radio driver: 501, nothing stored', async (type) => {
    answer();
    await expect(svc.createApCommandJob(ORG, 1, { device_id: 5, command_type: type, target_value: '20' }))
      .rejects.toMatchObject({ statusCode: 501, code: 'AP_COMMAND_NOT_IMPLEMENTED' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a future schedule is refused: nothing runs scheduled jobs', async () => {
    answer();
    const later = new Date(Date.now() + 3600e3).toISOString();
    await expect(svc.createApCommandJob(ORG, 1, { device_id: 5, command_type: 'reboot', scheduled_at: later }))
      .rejects.toMatchObject({ statusCode: 501 });
  });

  test('a device of another organization is 404', async () => {
    answer({ device: false });
    await expect(svc.createApCommandJob(ORG, 1, { device_id: 5, command_type: 'reboot' })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query.mock.calls[0][1]).toEqual([5, ORG]);
  });

  test('a device with no driver that can reboot it is 422', async () => {
    answer({ configs: [{ id: 3, vendor: 'cisco_ios' }] });
    await expect(svc.createApCommandJob(ORG, 1, { device_id: 5, command_type: 'reboot' })).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });

  test('a reboot is stored queued and its job queued', async () => {
    answer();
    const job = await svc.createApCommandJob(ORG, 1, { device_id: 5, command_type: 'reboot' });
    expect(job).toEqual({ id: 77, status: 'queued' });
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO ap_command_jobs/.test(sql));
    expect(insert[0]).toMatch(/'queued'/);
    expect(insert[1].slice(0, 3)).toEqual([ORG, 5, 'reboot']);
    expect(jobQueue.add).toHaveBeenCalledWith('ap-command', { jobId: 77, organizationId: ORG }, expect.objectContaining({ jobId: 'ap-command-77' }));
  });
});

describe('runApCommand', () => {
  const queued = { id: 77, organization_id: ORG, device_id: 5, command_type: 'reboot', status: 'queued', created_by: 1 };
  const final = () => db.query.mock.calls.filter(([sql]) => /SET status = \?, completed_at/.test(sql)).map(([, p]) => p);

  test('a reboot the device accepts completes with the execution id', async () => {
    answer({ job: queued });
    routerDriverService.dispatchCommand.mockResolvedValue({ status: 'success', execution_id: 9, response: { rebooted: true } });
    await expect(svc.runApCommand(77, ORG)).resolves.toBe('completed');
    expect(routerDriverService.dispatchCommand).toHaveBeenCalledWith(3, ORG, 'reboot', {}, 1);
    expect(final()[0][0]).toBe('completed');
    expect(JSON.parse(final()[0][1])).toEqual({ execution_id: 9, response: { rebooted: true } });
  });

  test('a refused reboot fails with the device error', async () => {
    answer({ job: queued });
    routerDriverService.dispatchCommand.mockResolvedValue({ status: 'failure', error_message: 'RouterOS reboot refused: not enough permissions' });
    await expect(svc.runApCommand(77, ORG)).resolves.toBe('failed');
    expect(final()[0]).toEqual(['failed', null, 'RouterOS reboot refused: not enough permissions', 77, ORG]);
  });

  test('a job left in_progress by a stopped process is failed, not sent again', async () => {
    answer({ job: { ...queued, status: 'in_progress' } });
    await expect(svc.runApCommand(77, ORG)).resolves.toBe('failed');
    expect(routerDriverService.dispatchCommand).not.toHaveBeenCalled();
  });

  test('a job cancelled before it is claimed is not run', async () => {
    answer({ job: { ...queued, status: 'cancelled' } });
    await expect(svc.runApCommand(77, ORG)).resolves.toBe('skipped');
    expect(routerDriverService.dispatchCommand).not.toHaveBeenCalled();
  });
});
