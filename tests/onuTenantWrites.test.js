// =============================================================================
// ONU routes — shared rows are read-only; writes take declared fields only
// =============================================================================
// Every write lookup accepted organization_id IS NULL rows, so one tenant
// could edit or delete the installation-shared ONU profiles (and whitelist,
// OMCI and job rows) every other tenant reads. Writes also spread the whole
// request body into the INSERT/UPDATE, and referenced devices, ports,
// profiles and plans were never checked against the caller's organization.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const ftthService = require('../src/services/ftthService');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body) => {
  const req = request(app)[method](`/api/v1/onu-management${path}`)
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');
  return body ? req.send(body) : req;
};
const wrote = re => db.query.mock.calls.some(([sql]) => re.test(sql));

// rows: { 'onu_profiles:5': { organization_id: null }, ... }; owned: Set of 'table:id'
function fixture({ rows = {}, owned = [] } = {}) {
  const ownedSet = new Set(owned);
  db.query.mockImplementation(async (sql, params = []) => {
    let m = /^SELECT [^]*? FROM (onu_\w+) WHERE id = \? AND \(organization_id = \? OR organization_id IS NULL\)/.exec(sql);
    if (m) {
      const row = rows[`${m[1]}:${params[0]}`];
      return [row ? [{ id: Number(params[0]), status: 'pending', ...row }] : []];
    }
    m = /^SELECT id FROM (\w+) WHERE id = \? AND organization_id <=> \?/.exec(sql)
      || /^SELECT id FROM (\w+) WHERE id = \? AND \(organization_id <=> \? OR organization_id IS NULL\)/.exec(sql);
    if (m) return [ownedSet.has(`${m[1]}:${params[0]}`) ? [{ id: params[0] }] : []];
    if (/^\s*INSERT/.test(sql)) return [{ insertId: 99 }];
    if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
    return [[{ id: 99 }]];
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

describe('installation-shared rows', () => {
  test.each([
    ['put', '/profiles/5', 'onu_profiles', { name: 'Hijacked' }],
    ['patch', '/profiles/5', 'onu_profiles', { name: 'Hijacked' }],
    ['delete', '/profiles/5', 'onu_profiles', null],
    ['put', '/details/5', 'onu_details', { notes: 'x' }],
    ['delete', '/whitelist/5', 'onu_whitelist', null],
    ['put', '/omci-configs/5', 'onu_omci_configs', { notes: 'x' }],
    ['post', '/firmware-jobs/5/cancel', 'onu_firmware_jobs', null],
    ['post', '/details/5/reboot', 'onu_details', null],
  ])('%s %s on a shared row is refused', async (method, path, table, body) => {
    fixture({ rows: { [`${table}:5`]: { organization_id: null } } });
    const res = await call(method, path, body);
    expect(res.status).toBe(403);
    expect(wrote(/^\s*(UPDATE|INSERT|"UPDATE)/)).toBe(false);
  });

  test('shared profiles are still listed for every tenant', async () => {
    db.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql)
      ? [[{ total: 1 }]] : [[{ id: 5, organization_id: null, name: 'Default GPON' }]]));
    const res = await call('get', '/profiles');
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Default GPON');
  });

  test("the tenant's own row is updated, scoped to its organization", async () => {
    fixture({ rows: { 'onu_profiles:5': { organization_id: 1 } } });
    const res = await call('put', '/profiles/5', { name: 'Mine' });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls.find(([s]) => /^UPDATE onu_profiles SET/.test(s));
    expect(sql).toMatch(/WHERE id = \? AND organization_id <=> \?$/);
    expect(params.slice(-2)).toEqual(['5', 1]);
  });
});

describe('only declared fields are written', () => {
  test('the edit form sending the whole row back writes only the schema fields', async () => {
    fixture({ rows: { 'onu_profiles:5': { organization_id: 1 } } });
    const res = await call('put', '/profiles/5', {
      id: 5, organization_id: 2, name: 'Mine', active_flag: 0, created_at: '2026-01-01', updated_at: '2026-01-02',
    });
    expect(res.status).toBe(200);
    const [sql] = db.query.mock.calls.find(([s]) => /^UPDATE onu_profiles SET/.test(s));
    expect(sql).toMatch(/^UPDATE onu_profiles SET `?name`? = \?, updated_at = NOW\(\) WHERE/);
  });

  test('an ONU detail cannot set its provisioning job link', async () => {
    fixture({ rows: { 'onu_details:5': { organization_id: 1 } } });
    await call('patch', '/details/5', { notes: 'n', last_provision_job_id: 77 });
    const [sql, params] = db.query.mock.calls.find(([s]) => /^UPDATE onu_details SET/.test(s));
    expect(sql).not.toMatch(/last_provision_job_id/);
    expect(params).not.toContain(77);
  });
});

describe('referenced rows must be the caller’s', () => {
  test("another tenant's device is refused on create", async () => {
    fixture();
    const res = await call('post', '/details', { device_id: 40 });
    expect(res.status).toBe(422);
    expect(wrote(/^INSERT INTO onu_details/)).toBe(false);
  });

  test('a shared profile may be referenced; a foreign plan may not', async () => {
    fixture({ owned: ['devices:4', 'onu_profiles:5'] });
    expect((await call('post', '/details', { device_id: 4, onu_profile_id: 5 })).status).toBe(201);
    expect((await call('post', '/profiles', { name: 'P', plan_id: 8 })).status).toBe(422);
  });

  test('provisioning with a foreign OLT is refused before a job is queued', async () => {
    fixture({ rows: { 'onu_details:5': { organization_id: 1, device_id: 4 } }, owned: ['devices:4'] });
    const provision = jest.spyOn(ftthService, 'provisionOnu');
    const res = await call('post', '/details/5/provision', { olt_device_id: 41 });
    expect(res.status).toBe(422);
    expect(provision).not.toHaveBeenCalled();
  });

  test('a firmware job for a foreign ONU is refused', async () => {
    fixture();
    const schedule = jest.spyOn(ftthService, 'scheduleFirmwareUpgrade');
    const res = await call('post', '/firmware-jobs', { job_type: 'firmware_upgrade', scope: 'single_onu', onu_device_id: 40 });
    expect(res.status).toBe(422);
    expect(schedule).not.toHaveBeenCalled();
  });
});
