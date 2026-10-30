// =============================================================================
// VigaBSS 5.0 — NET-09: on-demand config pull + template deploy isolation
// =============================================================================
// POST /device-config-backups/pull loaded the device by id alone and then
// opened a RouterOS session through that device's FireRelay agent using either
// the body credentials or the install-wide ROUTEROS_API_USER/PASSWORD env vars.
// An org-A user could therefore make org B's POP agent log into org B's router
// with the install operator's credentials and store the export.
//
// POST /config-templates/:id/deploy loaded template and device by id alone and
// always recorded status='success' ("push queued") although nothing is ever
// sent to the device.
//
// These tests drive the real routers and RBAC middleware against a database
// mock that honours organization predicates.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

// Stored driver-config passwords are decrypted with the real helper in
// production; here the ciphertext is a marker so the test can see which
// credential reached the device.
jest.mock('../src/utils/encryption', () => ({
  ...jest.requireActual('../src/utils/encryption'),
  decrypt: jest.fn((v) => `decrypted:${v}`),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const { tunnelServer } = require('../src/services/firerelayTunnel');
const app = require('../src/app');

const ORG_A = 1;
const ORG_B = 2;
const A_DEVICE_ID = 55;
const B_DEVICE_ID = 77;
const A_TEMPLATE_ID = 301;
const B_TEMPLATE_ID = 302;

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'admin@isp.example', role: 'admin', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

const DEVICES = {
  [A_DEVICE_ID]: { id: A_DEVICE_ID, organization_id: ORG_A, name: 'a-router', ip_address: '10.1.0.1', firerelay_node_id: 'pop-a' },
  [B_DEVICE_ID]: { id: B_DEVICE_ID, organization_id: ORG_B, name: 'b-router', ip_address: '10.2.0.1', firerelay_node_id: 'pop-b' },
};
const TEMPLATES = {
  [A_TEMPLATE_ID]: { id: A_TEMPLATE_ID, organization_id: ORG_A, template_content: '/system identity set name={{hostname}}', status: 'active' },
  [B_TEMPLATE_ID]: { id: B_TEMPLATE_ID, organization_id: ORG_B, template_content: '/user add name=b password=secret', status: 'active' },
};

const ORG_PREDICATE = /organization_id (<=>|=) \?/;

let granted;
let driverConfigs;
let deploymentInserts;
let backupInserts;
const savedEnv = {};

// A scoped lookup returns the row only when it binds the row's own org; an
// unscoped one (old behaviour) returns it to anyone.
function visible(sql, params, row) {
  if (!row) return [];
  if (!ORG_PREDICATE.test(sql)) return [row];
  return params.includes(row.organization_id) ? [row] : [];
}

beforeEach(() => {
  jest.clearAllMocks();
  granted = [];
  driverConfigs = [];
  deploymentInserts = [];
  backupInserts = [];
  for (const k of ['ROUTEROS_API_USER', 'ROUTEROS_API_PASSWORD']) savedEnv[k] = process.env[k];
  // The install operator's nightly-pull credentials are configured. A tenant's
  // on-demand pull must never borrow them.
  process.env.ROUTEROS_API_USER = 'install-operator';
  process.env.ROUTEROS_API_PASSWORD = 'install-operator-secret';

  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  jest.spyOn(tunnelServer, 'isConnected').mockReturnValue(true);
  jest.spyOn(tunnelServer, 'sendCommand').mockResolvedValue({ content: '/system identity\nset name=x', configType: 'export' });

  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?users`?\b/.test(sql)) {
      return [[{ id: 50, email: 'admin@isp.example', role: 'admin', status: 'active', organization_id: ORG_A }]];
    }
    if (/FROM router_driver_configs\b/.test(sql)) {
      return [driverConfigs.filter((c) => c.device_id === Number(params[0])
        && (!ORG_PREDICATE.test(sql) || params.includes(c.organization_id)))];
    }
    if (/FROM devices\b[\s\S]*WHERE id = \?/.test(sql)) {
      return [visible(sql, params, DEVICES[params[0]])];
    }
    if (/FROM config_templates\b[\s\S]*WHERE id = \?/.test(sql)) {
      return [visible(sql, params, TEMPLATES[params[0]])];
    }
    if (/INSERT INTO config_deployment_records/.test(sql)) {
      deploymentInserts.push({ sql, params });
      return [{ insertId: 900 + deploymentInserts.length }];
    }
    if (/INSERT INTO device_config_backups/.test(sql)) {
      backupInserts.push(params);
      return [{ insertId: 700 + backupInserts.length }];
    }
    return [[]];
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  jest.restoreAllMocks();
});

describe('POST /api/v1/device-config-backups/pull', () => {
  const pull = (orgId, body) => request(app)
    .post('/api/v1/device-config-backups/pull')
    .set('Authorization', `Bearer ${token(orgId)}`)
    .send(body);

  test('a foreign device is 404 and no RouterOS session is opened', async () => {
    granted = ['device_config_backups.create'];
    const res = await pull(ORG_A, { device_id: B_DEVICE_ID, user: 'admin', password: 'guess' });
    expect(res.status).toBe(404);
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
    expect(backupInserts).toHaveLength(0);
    // The device lookup itself carried the caller's org.
    const lookup = db.query.mock.calls.find(([sql]) => /FROM devices\b/.test(sql));
    expect(lookup[0]).toMatch(ORG_PREDICATE);
    expect(lookup[1]).toContain(ORG_A);
  });

  test('a foreign device is 404 even with no body credentials (env creds never used)', async () => {
    granted = ['device_config_backups.create'];
    const res = await pull(ORG_A, { device_id: B_DEVICE_ID });
    expect(res.status).toBe(404);
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
  });

  test('own device without body or stored credentials is 422 and does not fall back to env creds', async () => {
    granted = ['device_config_backups.create'];
    const res = await pull(ORG_A, { device_id: A_DEVICE_ID });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/credentials are required/i);
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toMatch(/install-operator/);
  });

  test('own device with body credentials pulls using exactly those credentials', async () => {
    granted = ['device_config_backups.create'];
    const res = await pull(ORG_A, { device_id: A_DEVICE_ID, user: 'tenant-a', password: 'tenant-a-pass' });
    expect(res.status).toBe(201);
    expect(tunnelServer.sendCommand).toHaveBeenCalledTimes(1);
    const [nodeId, method, params] = tunnelServer.sendCommand.mock.calls[0];
    expect(nodeId).toBe('pop-a');
    expect(method).toBe('config.backup');
    expect(params).toMatchObject({ host: '10.1.0.1', user: 'tenant-a', password: 'tenant-a-pass' });
  });

  test('body password without user defaults the user to admin, never the env user', async () => {
    granted = ['device_config_backups.create'];
    const res = await pull(ORG_A, { device_id: A_DEVICE_ID, password: 'tenant-a-pass' });
    expect(res.status).toBe(201);
    expect(tunnelServer.sendCommand.mock.calls[0][2]).toMatchObject({ user: 'admin', password: 'tenant-a-pass' });
  });

  test("own device with no body credentials uses the device's own stored driver config", async () => {
    granted = ['device_config_backups.create'];
    driverConfigs = [{ device_id: A_DEVICE_ID, organization_id: ORG_A, username: 'stored-user', encrypted_password: 'CIPHER', port: 8729 }];
    const res = await pull(ORG_A, { device_id: A_DEVICE_ID });
    expect(res.status).toBe(201);
    expect(tunnelServer.sendCommand.mock.calls[0][2]).toMatchObject({
      user: 'stored-user', password: 'decrypted:CIPHER', port: 8729,
    });
    const lookup = db.query.mock.calls.find(([sql]) => /FROM router_driver_configs\b/.test(sql));
    expect(lookup[0]).toMatch(ORG_PREDICATE);
    expect(lookup[1]).toEqual([A_DEVICE_ID, ORG_A]);
  });

  test("another org's driver config for the same device id is not used", async () => {
    granted = ['device_config_backups.create'];
    driverConfigs = [{ device_id: A_DEVICE_ID, organization_id: ORG_B, username: 'b-user', encrypted_password: 'B', port: 8728 }];
    const res = await pull(ORG_A, { device_id: A_DEVICE_ID });
    expect(res.status).toBe(422);
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/config-templates/:id/deploy', () => {
  const deploy = (orgId, templateId, body) => request(app)
    .post(`/api/v1/config-templates/${templateId}/deploy`)
    .set('Authorization', `Bearer ${token(orgId)}`)
    .send(body);

  test('a foreign template is 404 and no deployment record is written', async () => {
    granted = ['config_deployments.create'];
    const res = await deploy(ORG_A, B_TEMPLATE_ID, { device_id: A_DEVICE_ID });
    expect(res.status).toBe(404);
    expect(deploymentInserts).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });

  test('a foreign device is 404 and no deployment record is written', async () => {
    granted = ['config_deployments.create'];
    const res = await deploy(ORG_A, A_TEMPLATE_ID, { device_id: B_DEVICE_ID });
    expect(res.status).toBe(404);
    expect(deploymentInserts).toHaveLength(0);
  });

  test('own template + device: rendered, recorded as pending, never success, nothing sent to the device', async () => {
    granted = ['config_deployments.create'];
    const res = await deploy(ORG_A, A_TEMPLATE_ID, { device_id: A_DEVICE_ID, variables: { hostname: 'core-1' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      push_performed: false,
      rendered_config: '/system identity set name=core-1',
    });
    expect(res.body.data.result_output).toMatch(/apply the rendered config manually/);
    expect(deploymentInserts).toHaveLength(1);
    const { sql, params } = deploymentInserts[0];
    expect(params).toContain('pending');
    expect(params).not.toContain('success');
    expect(params[0]).toBe(ORG_A);
    // Not deployed, not completed.
    expect(sql).not.toMatch(/NOW\(\)/);
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
  });

  test('a tunnel being connected does not turn the record into success', async () => {
    granted = ['config_deployments.create'];
    tunnelServer.isConnected.mockReturnValue(true);
    const res = await deploy(ORG_A, A_TEMPLATE_ID, { device_id: A_DEVICE_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.status).not.toBe('success');
    expect(res.body.data.result_output).not.toMatch(/queued/i);
  });

  test('malformed variables JSON is 422, not 500', async () => {
    granted = ['config_deployments.create'];
    const res = await deploy(ORG_A, A_TEMPLATE_ID, { device_id: A_DEVICE_ID, variables: '{not json' });
    expect(res.status).toBe(422);
    expect(deploymentInserts).toHaveLength(0);
  });
});
