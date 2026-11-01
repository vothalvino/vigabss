'use strict';
// =============================================================================
// NET-19 — the ACS follows the CWMP session: Inform, empty POST, RPCs, 204
// =============================================================================
// An Inform was answered with the queued task's RPC instead of InformResponse,
// and the CPE's empty POST (where TR-069 lets the ACS send RPCs) got 200 '' and
// ended the session. A CPE that authenticated only on its first request had
// its RPC response rejected, and dispatched tasks stayed in_progress for ever.
// =============================================================================

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/cwmpSessionService', () => ({
  handleInform: jest.fn().mockResolvedValue({ tasks: [] }),
  getNextTask: jest.fn(),
  buildResponseForTask: jest.fn((task) => `<rpc task="${task.id}"/>`),
  processTaskResponse: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/cpeSessionLogService', () => ({ logSessionEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/cpeDiagnosticsService', () => ({ handleDiagnosticsComplete: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/cpeInventoryService', () => ({ tryAutoLinkSubscriber: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/portalServiceRequestService', () => ({ settleWifiRequestForTask: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const config = require('../src/config');
const cwmpSessionService = require('../src/services/cwmpSessionService');
const portal = require('../src/services/portalServiceRequestService');
const acsService = require('../src/services/acsService');
const app = require('../src/app');

const envelope = (body) => `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soapenv:Header><cwmp:ID>1</cwmp:ID></soapenv:Header>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
const INFORM = envelope(`<cwmp:Inform>
    <DeviceId><Manufacturer>Acme</Manufacturer><OUI>EC1724</OUI><ProductClass>X</ProductClass><SerialNumber>SN-1</SerialNumber></DeviceId>
    <Event><EventStruct><EventCode>2 PERIODIC</EventCode><CommandKey></CommandKey></EventStruct></Event>
    <ParameterList></ParameterList>
  </cwmp:Inform>`);
const SET_RESPONSE = envelope('<cwmp:SetParameterValuesResponse><Status>0</Status></cwmp:SetParameterValuesResponse>');

// Device 5 has no credentials of its own: it authenticates with the ACS-wide
// credential, on its first request only.
const DEVICE = { id: 5, organization_id: 1, serial_number: 'SN-1', oui: 'EC1724', acs_username: null, acs_password_hash: null };
const TASK = { id: 41, cpe_device_id: 5, task_type: 'set_parameter_values', status: 'queued' };
const shared = () => `Basic ${Buffer.from('acs-shared:shared-secret').toString('base64')}`;

let inProgress;
beforeAll(async () => { await bcrypt.hash('x', 4); });
beforeEach(() => {
  jest.clearAllMocks();
  acsService.resetAutoRegistrations();
  config.acs.username = 'acs-shared';
  config.acs.password = 'shared-secret';
  config.acs.autoRegistrationsPerHour = 30;
  inProgress = null;
  cwmpSessionService.getNextTask.mockImplementation(async () => (inProgress ? null : { ...TASK }));
  db.query.mockImplementation(async (sql, params = []) => {
    if (/serial_number = \? AND oui = \?/.test(sql)) return [[{ ...DEVICE }]];
    if (/FROM cpe_devices WHERE id = \?/.test(sql)) return [Number(params[0]) === 5 ? [{ ...DEVICE }] : []];
    if (/SET status = 'in_progress'/.test(sql)) { inProgress = { ...TASK, status: 'in_progress' }; return [{ affectedRows: 1 }]; }
    if (/status = 'in_progress' ORDER BY started_at/.test(sql)) return [inProgress ? [inProgress] : []];
    return [{ affectedRows: 1 }];
  });
});

const post = (body, headers = {}) => {
  let r = request(app).post('/acs/cwmp').set('Content-Type', 'text/xml');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return body === null ? r.send('') : r.send(body);
};

test('a full session: Inform, empty POST, RPC, response, 204', async () => {
  // 1. Inform with a task queued: InformResponse, never the task's RPC.
  const inform = await post(INFORM, { Authorization: shared() });
  expect(inform.status).toBe(200);
  expect(inform.text).toContain('InformResponse');
  expect(inform.text).not.toContain('<rpc');
  expect(db.query.mock.calls.some(([sql]) => /SET status = 'in_progress'/.test(sql))).toBe(false);
  const cookie = inform.headers['set-cookie'][0].split(';')[0];
  expect(cookie).toMatch(/^cwmpsid=[0-9a-f]{48}$/);

  // 2. Empty POST in the session, with no credentials: the queued RPC.
  const empty = await post(null, { Cookie: cookie });
  expect(empty.status).toBe(200);
  expect(empty.text).toBe('<rpc task="41"/>');
  expect(inProgress).toBeTruthy();

  // 3. The CPE's response, still known by its session; nothing else queued.
  const answer = await post(SET_RESPONSE, { Cookie: cookie });
  expect(cwmpSessionService.processTaskResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }), expect.objectContaining({ status: 0 }));
  expect(answer.status).toBe(204);
});

test('an empty POST with no session ends quietly', async () => {
  const res = await post(null);
  expect(res.status).toBe(204);
  expect(cwmpSessionService.getNextTask).not.toHaveBeenCalled();
});

test('an unknown session cookie does not stand in for credentials', async () => {
  const res = await post(SET_RESPONSE, { Cookie: `cwmpsid=${'a'.repeat(48)}` });
  expect(res.status).toBe(401);
  expect(res.headers['www-authenticate']).toMatch(/Basic/);
  expect(cwmpSessionService.processTaskResponse).not.toHaveBeenCalled();
});

describe('reapStuckTasks', () => {
  test('fails tasks left in_progress and settles a waiting Wi-Fi request', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/^SELECT id, task_type FROM cpe_tasks/.test(sql.trim())) {
        return [[{ id: 41, task_type: 'set_parameter_values' }, { id: 42, task_type: 'reboot' }]];
      }
      return [{ affectedRows: 1 }];
    });
    const res = await acsService.reapStuckTasks(1);
    expect(res).toEqual({ reaped: 2 });
    const [selectSql, selectParams] = db.query.mock.calls[0];
    expect(selectSql).toMatch(/status = 'in_progress'\s+AND started_at < \(NOW\(\) - INTERVAL \? MINUTE\)/);
    expect(selectParams).toEqual([1, 30]);
    const fails = db.query.mock.calls.filter(([sql]) => /SET status = 'failed'/.test(sql));
    expect(fails.map(([, p]) => p[0])).toEqual([41, 42]);
    expect(portal.settleWifiRequestForTask).toHaveBeenCalledTimes(1);
    expect(portal.settleWifiRequestForTask).toHaveBeenCalledWith(41, false, expect.any(String));
  });

  test('is dispatched by the reap_stuck_cpe_tasks scheduled task', () => {
    const src = require('fs').readFileSync(require.resolve('../src/services/taskRunner'), 'utf8');
    expect(src).toMatch(/case 'reap_stuck_cpe_tasks':\s+return perOrganization\(taskName, organizationId, orgId => require\('\.\/acsService'\)\.reapStuckTasks\(orgId\)\)/);
  });
});
