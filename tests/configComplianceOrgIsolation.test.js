// =============================================================================
// VigaBSS 5.0 — Config compliance runs: organization isolation + ReDoS guard
// =============================================================================
// configBackupService.runComplianceAudit used to load the backup (and its
// device) by id alone, so an org-A caller with config_compliance.run could POST
// /device-config-backups/compliance-run or /config-compliance-rules/run with an
// org-B backup_id: the caller's own rules were evaluated against org-B router
// config (a pass/fail oracle over another tenant's RouterOS export) and result
// rows were INSERTed against org B's backup. These tests drive the real routers
// and RBAC middleware against a database mock that honours org predicates.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// The caller is an ordinary (non-global) user in whatever org the token names.
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

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const ORG_A = 1;
const ORG_B = 2;
const B_BACKUP_ID = 2005;
const B_DEVICE_ID = 77;

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'admin@isp.example', role: 'admin', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

const BACKUPS = {
  [B_BACKUP_ID]: {
    id: B_BACKUP_ID, organization_id: ORG_B, device_id: B_DEVICE_ID, version: 3,
    content: '/user add name=admin password=s3cret\n/ip service set telnet disabled=no',
    diff_from_previous: '+/user add name=admin password=s3cret', deleted_at: null,
  },
};
const DEVICES = { [B_DEVICE_ID]: { id: B_DEVICE_ID, organization_id: ORG_B, device_type: 'router' } };

// Each org has one enabled regex rule of its own.
const rulesFor = (orgId) => [{
  id: 900 + orgId, organization_id: orgId, rule_type: 'regex_match', pattern: 'password=s3', applies_to_device_type: null,
}];

const ORG_PREDICATE = /organization_id (<=>|=) \?/;

let granted;
let resultInserts;
let backupLookups;

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
  resultInserts = [];
  backupLookups = [];
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?users`?\b/.test(sql)) {
      return [[{ id: 50, email: 'admin@isp.example', role: 'admin', status: 'active', organization_id: ORG_A }]];
    }
    if (/FROM device_config_backups\b[\s\S]*WHERE id = \?/.test(sql)) {
      backupLookups.push({ sql, params });
      return [visible(sql, params, BACKUPS[params[0]])];
    }
    if (/FROM devices\b[\s\S]*WHERE id = \?/.test(sql)) {
      return [visible(sql, params, DEVICES[params[0]])];
    }
    if (/FROM config_compliance_rules\b[\s\S]*is_enabled = 1/.test(sql)) {
      return [rulesFor(params[0])];
    }
    if (/INSERT INTO config_compliance_results/.test(sql)) {
      resultInserts.push(params);
      return [{ insertId: resultInserts.length }];
    }
    if (/INSERT INTO config_compliance_rules/.test(sql)) return [{ insertId: 1 }];
    return [[]];
  });
});

afterEach(() => jest.restoreAllMocks());

describe.each([
  ['/api/v1/device-config-backups/compliance-run'],
  ['/api/v1/config-compliance-rules/run'],
])('POST %s', (path) => {
  test('another organization gets 404 for a foreign backup and no result row is written', async () => {
    granted = ['config_compliance.run'];
    const res = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${token(ORG_A)}`)
      .send({ backup_id: B_BACKUP_ID });
    expect(res.status).toBe(404);
    expect(resultInserts).toHaveLength(0);
    expect(backupLookups).toHaveLength(1);
    expect(backupLookups[0].sql).toMatch(ORG_PREDICATE);
    expect(backupLookups[0].params).toContain(ORG_A);
    // Nothing about the foreign config leaks through the error body.
    expect(JSON.stringify(res.body)).not.toMatch(/s3cret|passed|failed/);
  });

  test('the owning organization can run the audit and a result row is written', async () => {
    granted = ['config_compliance.run'];
    const res = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${token(ORG_B)}`)
      .send({ backup_id: B_BACKUP_ID });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ total: 1, passed: 1, failed: 0 });
    expect(resultInserts).toHaveLength(1);
    expect(resultInserts[0]).toEqual(expect.arrayContaining([900 + ORG_B, B_BACKUP_ID, B_DEVICE_ID, 'pass']));
  });
});

describe('GET /api/v1/device-config-backups/diff/:id', () => {
  test('stays 404 cross-org', async () => {
    granted = ['device_config_backups.view'];
    const res = await request(app)
      .get(`/api/v1/device-config-backups/diff/${B_BACKUP_ID}`)
      .set('Authorization', `Bearer ${token(ORG_A)}`);
    expect(res.status).toBe(404);
  });

  test('owner gets the diff', async () => {
    granted = ['device_config_backups.view'];
    const res = await request(app)
      .get(`/api/v1/device-config-backups/diff/${B_BACKUP_ID}`)
      .set('Authorization', `Bearer ${token(ORG_B)}`);
    expect(res.status).toBe(200);
  });
});

describe('ReDoS guard at rule create / update', () => {
  const base = { name: 'evil', rule_type: 'regex_match' };

  test.each([
    ['(a+)+$'],
    ['(\\w+\\s?)*$'],
    ['(.*)*x'],
    ['(a)\\1'],
    ['x'.repeat(501)],
    ['(unclosed'],
  ])('POST rejects unsafe/invalid regex %p with 422 and writes nothing', async (pattern) => {
    granted = ['config_compliance.create'];
    const res = await request(app)
      .post('/api/v1/config-compliance-rules')
      .set('Authorization', `Bearer ${token(ORG_A)}`)
      .send({ ...base, pattern });
    expect(res.status).toBe(422);
    const inserts = db.query.mock.calls.filter(([sql]) => /INSERT INTO config_compliance_rules/.test(sql));
    expect(inserts).toHaveLength(0);
  });

  test('POST accepts an ordinary regex', async () => {
    granted = ['config_compliance.create'];
    const res = await request(app)
      .post('/api/v1/config-compliance-rules')
      .set('Authorization', `Bearer ${token(ORG_A)}`)
      .send({ ...base, pattern: '^/ip service set telnet disabled=(yes|no)$' });
    expect(res.status).toBe(201);
  });

  test('POST does not regex-vet must_contain literals', async () => {
    granted = ['config_compliance.create'];
    const res = await request(app)
      .post('/api/v1/config-compliance-rules')
      .set('Authorization', `Bearer ${token(ORG_A)}`)
      .send({ name: 'lit', rule_type: 'must_contain', pattern: '(a+)+' });
    expect(res.status).toBe(201);
  });

  test('PUT switching an existing literal rule to regex_match vets the stored pattern', async () => {
    granted = ['config_compliance.update'];
    const base404 = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params = []) => {
      if (/SELECT id, rule_type, pattern FROM config_compliance_rules/.test(sql)) {
        return [[{ id: 5, rule_type: 'must_contain', pattern: '(a+)+$' }]];
      }
      return base404(sql, params);
    });
    const res = await request(app)
      .put('/api/v1/config-compliance-rules/5')
      .set('Authorization', `Bearer ${token(ORG_A)}`)
      .send({ rule_type: 'regex_match' });
    expect(res.status).toBe(422);
    const updates = db.query.mock.calls.filter(([sql]) => /UPDATE config_compliance_rules SET/.test(sql));
    expect(updates).toHaveLength(0);
  });
});
