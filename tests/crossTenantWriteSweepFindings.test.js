'use strict';
// =============================================================================
// TNA-37 — writes refuse another organization's ids
// =============================================================================
// The real-database write sweep found two kinds of cross-tenant write:
//   - a create stored another organization's id from the body (a client in
//     another organization's group, a lead assigned to another organization's
//     user, a splitter on another organization's OLT port, …);
//   - an action on another organization's id in the path answered 2xx: the
//     scoped UPDATE matched nothing, and the route said success anyway (or,
//     for the NAS health check, ran every NAS of the caller's organization).
// These drive the real routers against a fake database in which id 77 is
// another organization's row and every org-scoped statement misses it.
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
    authorizationRole: 'manager',
    membershipRole: 'manager',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

const routeInventory = require('./helpers/routeInventory');

routeInventory.install();

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const Organization = require('../src/models/Organization');
const app = require('../src/app');

const ORG = 1001;
const FOREIGN = 77;

const token = jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'manager', orgId: ORG },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

// What each route requires, and nothing else.
const GRANTED = [
  'clients.create', 'leads.create', 'winback.create', 'mapping.infrastructure_manage',
  'config_backup_schedules.create', 'maintenance_windows.create', 'sms.send', 'olt_splitters.create',
  'ap_channel_plans.create', 'wireless_channels.manage', 'interface_qos_policies.create',
  'nas.health_check', 'data_packs.update', 'data_packs.delete', 'dsar_requests.manage',
  'uso_obligations.manage', 'plans.update', 'plan_access_windows.delete',
  'interface_qos_policies.delete', 'dscp_marking_policies.delete',
];

let writes;
async function respond(sql, params = []) {
  if (/FROM `?users`?\b/.test(sql) && !/organization_users/.test(sql)) {
    return [[{ id: 50, email: 'staff@isp.example', role: 'manager', status: 'active', organization_id: ORG }]];
  }
  const foreign = params.some(p => Number(p) === FOREIGN);
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    // Every write is scoped to the caller's organization: B's id matches nothing.
    return [{ insertId: 900, affectedRows: foreign ? 0 : 1 }];
  }
  if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0, count: 0, n: 0 }]];
  return [[]];
}

// A body the route's validate() schemas accept, plus `ids`.
function bodyFor(method, path, ids) {
  const route = routeInventory.list(app).find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const schema = Object.assign({}, ...route.chain.filter(fn => fn && fn.schema).map(fn => fn.schema));
  const body = {};
  for (const [field, rules] of Object.entries(schema)) {
    if (!rules.required) continue;
    if (Array.isArray(rules.enum) && rules.enum.length) body[field] = rules.enum[0];
    else if (rules.type === 'number') body[field] = Math.max(1, Number(rules.min) || 1);
    else if (rules.type === 'boolean') body[field] = true;
    else if (rules.type === 'email') body[field] = 'a@example.com';
    else if (rules.type === 'array') body[field] = [];
    else if (rules.type === 'object') body[field] = {};
    else if (/date|_at$|start|end/.test(field)) body[field] = '2026-06-15T10:00:00Z';
    else body[field] = 'x'.repeat(Math.max(1, Number(rules.min) || 1)).slice(0, Number(rules.max) || 50);
  }
  if (/phone|^to$/.test(Object.keys(body).join(' '))) Object.assign(body, { to: '+525512345678' });
  return { ...body, ...ids };
}

beforeAll(() => {
  Object.assign(config.features, { snmp: true, radius: true, sms: true, wireless: true, olt: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  writes = [];
  jest.spyOn(User, 'getPermissions').mockResolvedValue(GRANTED);
  jest.spyOn(User, 'count').mockResolvedValue(0);
  jest.spyOn(Organization, 'getLocale').mockResolvedValue('MX');
  db.query.mockImplementation(respond);
  db.execute.mockImplementation(respond);
  db.getConnection.mockImplementation(async () => ({
    query: jest.fn(respond), execute: jest.fn(respond),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }));
});

// [path, the body's foreign id, the table that must not be written]
const LINKS = [
  ['/api/v1/clients', { client_group_id: FOREIGN }, 'clients'],
  ['/api/v1/leads', { assigned_to: FOREIGN }, 'leads'],
  ['/api/v1/winback-campaigns', { message_template_id: FOREIGN }, 'winback_campaigns'],
  ['/api/v1/topology/infrastructure', { site_id: FOREIGN }, 'map_infrastructure_points'],
  ['/api/v1/config-backup-schedules', { device_id: FOREIGN }, 'config_backup_schedules'],
  ['/api/v1/alerts/maintenance-windows', { device_id: FOREIGN }, 'maintenance_windows'],
  ['/api/v1/alerts/maintenance-windows', { site_id: FOREIGN }, 'maintenance_windows'],
  ['/api/v1/sms/send', { clientId: FOREIGN }, 'message_outbox'],
  ['/api/v1/olt-management/splitters', { olt_port_id: FOREIGN }, 'olt_splitters'],
  ['/api/v1/olt-management/splitters', { site_id: FOREIGN }, 'olt_splitters'],
  ['/api/v1/wireless/channel-plans', { site_id: FOREIGN }, 'ap_channel_plans'],
  ['/api/v1/wireless/channel-interference', { ap_sector_config_id: FOREIGN }, 'wireless_channel_interference'],
  ['/api/v1/wireless/channel-interference', { site_id: FOREIGN }, 'wireless_channel_interference'],
  ['/api/v1/interface-qos-policies', { device_id: FOREIGN }, 'interface_qos_policies'],
];

test.each(LINKS)('POST %s with %j is refused and writes nothing to %s', async (path, ids, table) => {
  const res = await request(app).post(path).set('Authorization', `Bearer ${token}`).send(bodyFor('POST', path, ids));
  expect({ status: res.status, field: res.body?.error?.message }).toEqual({
    status: 422, field: expect.stringContaining(Object.keys(ids)[0]),
  });
  expect(writes.filter(w => w.includes(table))).toEqual([]);
});

// [method, path with another organization's id]
const ACTIONS = [
  ['post', '/api/v1/nas/77/health-check'],
  ['post', '/api/v1/data-packs/77/restore'],
  ['put', '/api/v1/regulatory-compliance/dsar-requests/77/fulfill'],
  ['put', '/api/v1/regulatory-compliance/dsar-requests/77/reject'],
  ['put', '/api/v1/universal-service/uso-obligations/77/report'],
  ['delete', '/api/v1/plans/77/speed-windows/77'],
  ['delete', '/api/v1/plans/77/access-windows/77'],
  ['delete', '/api/v1/wireless/channel-interference/77'],
  ['delete', '/api/v1/data-packs/77'],
  ['delete', '/api/v1/interface-qos-policies/77'],
  ['delete', '/api/v1/dscp-marking-policies/77'],
];

test.each(ACTIONS)('%s %s answers 404', async (method, path) => {
  const res = await request(app)[method](path).set('Authorization', `Bearer ${token}`).send({ notes: 'n', actual_value: 1 });
  expect(res.status).toBe(404);
});

test('the NAS health check probes only the NAS in the path', async () => {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?nas`? WHERE id = \?/.test(sql)) return [[{ id: 5, organization_id: ORG, status: 'active' }]];
    if (/FROM nas\s+WHERE status = 'active'/.test(sql)) {
      return [params.includes(5) ? [] : [{ id: 6, ip_address: '10.0.0.6', organization_id: ORG }]];
    }
    return respond(sql, params);
  });
  const res = await request(app).post('/api/v1/nas/5/health-check').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const probe = db.query.mock.calls.find(([sql]) => /FROM nas\s+WHERE status = 'active'/.test(sql));
  expect(probe[0]).toMatch(/AND id = \?/);
  expect(probe[1]).toEqual(expect.arrayContaining([ORG, 5]));
});
