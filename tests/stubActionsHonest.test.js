// =============================================================================
// TNB-37 — actions with no implementation do not report success
// =============================================================================
// Provisioning pipelines reported assign_ip as a completed stage with
// 0.0.0.0 and send_notification as "dispatched" without sending; ONU
// provision and reboot answered 202 "dispatched by background processor"
// though that processor is not implemented; CPE security scans were created
// 'pending' and never ran; and a scheduled task whose handler returns
// { deferred: true } was recorded as a success, both by the scheduler and by
// the manual Run button.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const automationService = require('../src/services/automationService');
const taskRunner = require('../src/services/taskRunner');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql) => {
    if (/FROM onu_details WHERE id = \?/.test(sql)) return [[{ id: 4, device_id: 40, olt_device_id: 41, organization_id: 1 }]];
    if (/SELECT id FROM onu_details WHERE device_id = \?/.test(sql)) return [[{ id: 4 }]];
    if (/SELECT \* FROM onu_details WHERE id = \?/.test(sql)) return [[{ id: 4, device_id: 40 }]];
    if (/FROM provisioning_pipelines WHERE id = \?/.test(sql)) return [[{ id: 9 }]];
    if (/^\s*SELECT/i.test(sql)) return [[{ id: 1, organization_id: 1 }]];
    return [{ insertId: 9, affectedRows: 1 }];
  });
});

const writesTo = (table) => db.query.mock.calls.filter(([sql]) => new RegExp(`INSERT INTO ${table}`).test(sql));

test('a pipeline whose stages are not implemented is not reported completed', async () => {
  await automationService.runProvisioningPipeline(1, { name: 'p', triggered_by: 1 });
  const stageUpdates = db.query.mock.calls
    .filter(([sql]) => /UPDATE provisioning_pipeline_stages/.test(sql))
    .map(([, p]) => ({ name: p[4], status: p[0], output: JSON.parse(p[1]) }));
  for (const name of ['assign_ip', 'configure_device', 'send_notification']) {
    const stage = stageUpdates.find((s) => s.name === name);
    expect(stage.status).toBe('skipped');
    expect(stage.output.implemented).toBe(false);
  }
  expect(JSON.stringify(stageUpdates)).not.toMatch(/0\.0\.0\.0|dispatched/);
  const [, finalParams] = db.query.mock.calls.find(([sql]) => /UPDATE provisioning_pipelines\s+SET status = \?, stages_results/.test(sql));
  expect(finalParams[0]).toBe('failed');
  expect(finalParams[2]).toMatch(/Nothing was provisioned/);
});

describe('ONU and CPE actions', () => {
  const app = require('../src/app');

  test('ONU reboot is refused with 501 and nothing is queued', async () => {
    const res = await request(app).post('/api/v1/onu-management/details/4/reboot').send({});
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('ONU_ACTION_NOT_IMPLEMENTED');
    expect(writesTo('onu_firmware_jobs')).toHaveLength(0);
  });

  test('a device reboot of an ONU is refused the same way', async () => {
    const deviceActions = require('../src/services/deviceActionsService');
    db.query.mockImplementation(async (sql) => {
      if (/FROM `?devices`?/.test(sql)) return [[{ id: 40, type: 'onu', organization_id: 1 }]];
      if (/FROM onu_details/.test(sql)) return [[{ device_id: 40, olt_device_id: 41 }]];
      return [[]];
    });
    const fn = deviceActions.rebootDevice || deviceActions.reboot;
    await expect(fn(40, 1, 1)).rejects.toMatchObject({ statusCode: 501 });
    expect(writesTo('onu_firmware_jobs')).toHaveLength(0);
  });

  test('ONU provision saves the details and says nothing was pushed to the OLT', async () => {
    const res = await request(app).post('/api/v1/onu-management/details/4/provision').send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dispatched: false, job: null });
    expect(res.body.message).toMatch(/not implemented/);
    expect(writesTo('onu_firmware_jobs')).toHaveLength(0);
  });

  test('a CPE security scan is refused with 501 and nothing is recorded', async () => {
    const res = await request(app).post('/api/v1/network-security/cpe-security-scans').send({ scan_type: 'open_ports', device_id: 40 });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('CPE_SCAN_NOT_IMPLEMENTED');
    expect(writesTo('cpe_security_scans')).toHaveLength(0);
  });
});

describe('deferred scheduled tasks', () => {
  test('a deferred result is recorded as skipped, not success', async () => {
    expect(taskRunner.completionStatus({ message: 'handler not yet implemented', deferred: true })).toBe('skipped');
    expect(taskRunner.completionStatus({ skipped: true, reason: 'already_running' })).toBe('skipped');
    expect(taskRunner.completionStatus({ processed: 3 })).toBe('success');

    await taskRunner.markTaskRun('ftth_onu_discovery', { deferred: true }, { taskId: 12 });
    const [, params] = db.query.mock.calls.find(([sql]) => /UPDATE scheduled_tasks/.test(sql));
    expect(params[0]).toBe('skipped');
  });

  test('the manual Run uses the same rule', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'scheduledTasks.js'), 'utf8');
    expect(src).toMatch(/const completionStatus = taskRunner\.completionStatus\(result\);/);
  });
});
