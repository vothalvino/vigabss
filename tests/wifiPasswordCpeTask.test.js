// =============================================================================
// NET-12 — a Wi-Fi password change reaches the CPE, and is "done" only then
// =============================================================================
// queueWifiPasswordCpeTask stored {parameters: [...]}, and buildResponseForTask
// sent a SetParameterValues only for a bare array, so the CPE received an empty
// ParameterList without the PSK. The request turned 'completed' as soon as the
// task was queued, the WhatsApp bot said "Done", and the subscriber's devices
// could not connect with the emailed password. API-created set tasks were
// always empty too: the schema refused arrays.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const cwmp = require('../src/services/cwmpSessionService');
const portal = require('../src/services/portalServiceRequestService');

const PSK = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey';
const taskXml = (parameters) => cwmp.buildResponseForTask({ id: 41, task_type: 'set_parameter_values', parameters });

beforeEach(() => jest.clearAllMocks());

describe('the SetParameterValues sent to the CPE carries the new PSK', () => {
  test('as queued by the portal and WhatsApp', async () => {
    let stored;
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM cpe_devices/.test(sql)) return [[{ id: 3, organization_id: 1 }]];
      if (/^INSERT INTO `?cpe_tasks`?/.test(sql)) {
        const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map((c) => c.trim().replace(/`/g, ''));
        stored = params[cols.indexOf('parameters')];
        return [{ insertId: 41 }];
      }
      if (/FROM `?cpe_tasks`?/.test(sql)) return [[{ id: 41 }]];
      return [[]];
    });
    const res = await portal.queueWifiPasswordCpeTask({ organizationId: 1, contractId: 9, newPassword: 'N3wPassw0rd' });
    expect(res).toEqual({ queued: true, taskId: 41 });
    const xml = taskXml(stored);
    expect(xml).toContain(`<Name>${PSK}</Name>`);
    expect(xml).toContain('N3wPassw0rd');
    expect(xml).toMatch(/arrayType="cwmp:ParameterValueStruct\[1\]"/);
  });

  test('for a task stored with the old {parameters} wrapper', () => {
    const xml = taskXml(JSON.stringify({ parameters: [{ name: PSK, value: 'Old0ne', type: 'xsd:string' }] }));
    expect(xml).toContain('Old0ne');
  });

  test('for a {path: value} map and a [{path, value}] list', () => {
    expect(taskXml({ 'Device.WiFi.SSID.1.SSID': 'Casa' })).toContain('Casa');
    expect(taskXml([{ path: 'Device.WiFi.SSID.1.SSID', value: 'Casa2' }])).toContain('Casa2');
  });
});

describe('the request completes when the router confirms', () => {
  test('approval links it to the task and leaves it approved', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM portal_service_requests/.test(sql)) {
        return [[{ id: 5, organization_id: 1, contract_id: 9, request_type: 'wifi_password_change', status: 'pending', payload: { new_password: 'N3w' } }]];
      }
      if (/FROM cpe_devices/.test(sql)) return [[{ id: 3, organization_id: 1 }]];
      if (/^INSERT INTO `?cpe_tasks`?/.test(sql)) return [{ insertId: 41 }];
      if (/FROM `?cpe_tasks`?/.test(sql)) return [[{ id: 41 }]];
      if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
    await portal.approveRequest(5, 1, 8, null);
    const sqls = db.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((sql) => /SET status = 'completed'/.test(sql))).toBe(false);
    const link = db.query.mock.calls.find(([sql]) => /JSON_SET\(COALESCE\(payload, JSON_OBJECT\(\)\), '\$\.cpe_task_id', \?\)/.test(sql));
    expect(link[1]).toEqual([41, 5]);
  });

  test.each([[0, true], [1, true], [9001, false]])('SetParameterValuesResponse status %i settles it (%s)', async (status, applied) => {
    db.query.mockResolvedValue([{ affectedRows: 1 }]);
    await cwmp.processTaskResponse({ id: 41, task_type: 'set_parameter_values', cpe_device_id: 3, organization_id: 1 }, { status });
    const settle = db.query.mock.calls.find(([sql]) => /UPDATE portal_service_requests/.test(sql));
    expect(settle[0]).toMatch(/JSON_EXTRACT\(payload, '\$\.cpe_task_id'\) = \?/);
    if (applied) {
      expect(settle[0]).toMatch(/SET status = 'completed'/);
      expect(settle[1]).toEqual([41]);
    } else {
      expect(settle[0]).toMatch(/cpe_error/);
      expect(settle[0]).not.toMatch(/'completed'/);
    }
  });
});

describe('POST /api/v1/cpe-management/devices/:id/tasks', () => {
  const app = require('../src/app');
  beforeEach(() => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM `?cpe_devices`?/.test(sql)) return [[{ id: 3, organization_id: 1 }]];
      if (/^INSERT/.test(sql)) return [{ insertId: 42 }];
      return [[{ id: 42 }]];
    });
  });

  test('accepts a list of parameters for a set task', async () => {
    const res = await request(app).post('/api/v1/cpe-management/devices/3/tasks')
      .send({ task_type: 'set_parameter_values', parameters: [{ name: PSK, value: 'Abc12345' }] });
    expect(res.status).toBe(201);
  });

  test('refuses a set task with nothing to set', async () => {
    const res = await request(app).post('/api/v1/cpe-management/devices/3/tasks')
      .send({ task_type: 'set_parameter_values', parameters: {} });
    expect(res.status).toBe(422);
  });
});
