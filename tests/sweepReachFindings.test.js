'use strict';
// =============================================================================
// Findings from the routes the real-database sweep newly reached
// =============================================================================
// Once every parameterised route resolved, the sweep found a filing that
// could cite another organization's concession title, restores and identity
// reviews that answered 200 for a row that is not the caller's, and three
// 500s: the coverage-zone list parsing an already-decoded JSON column, a
// support channel's first save binding NULL into NOT NULL columns, and an
// unknown report name. These drive the real routers against a fake database.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
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
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const Organization = require('../src/models/Organization');
const communicationPreferences = require('../src/services/clientCommunicationPreferenceService');
const app = require('../src/app');

const ORG = 1001;
const token = jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'admin', orgId: ORG },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

let calls;
// Rows a test makes visible: { table: [rows] } for SELECT ... FROM table.
let rows;
async function respond(sql, params = []) {
  calls.push({ sql, params });
  if (params.some(p => p === undefined)) {
    throw new TypeError('Bind parameters must not contain undefined. To pass SQL NULL specify JS null');
  }
  if (/FROM `?users`?\b/.test(sql) && !/organization_users/.test(sql)) {
    return [[{ id: 50, email: 'staff@isp.example', role: 'admin', status: 'active', organization_id: ORG }]];
  }
  if (/LAST_INSERT_ID\(\) AS id/.test(sql)) return [[{ id: 1 }]];
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    const table = (sql.match(/^\s*(?:INSERT INTO|UPDATE|DELETE FROM)\s+`?([a-z_0-9]+)/i) || [])[1];
    return [{ insertId: 900, affectedRows: (rows[table] || []).length ? 1 : 0 }];
  }
  if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0 }]];
  const table = (sql.match(/\bFROM\s+`?([a-z_0-9]+)`?/i) || [])[1];
  return [rows[table] || []];
}
const inserts = table => calls.filter(c => new RegExp(`^\\s*INSERT INTO \`?${table}\\b`).test(c.sql));
const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).send(body);

beforeAll(() => {
  Object.assign(config.features, { snmp: true, radius: true, wireless: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  rows = {};
  jest.spyOn(Organization, 'getLocale').mockResolvedValue('MX');
  jest.spyOn(Organization, 'getCurrency').mockResolvedValue('MXN');
  jest.spyOn(communicationPreferences, 'getOrganizationDeliveryState').mockResolvedValue({ active: true });
  db.query.mockImplementation(respond);
  db.execute.mockImplementation(respond);
  db.getConnection.mockImplementation(async () => ({
    query: jest.fn(respond), execute: jest.fn(respond),
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }));
});

const B_TITLE = 77;

test.each([
  ['a regulatory filing', '/regulatory-filings', { filing_type: 'other', concession_title_id: B_TITLE }, 'regulatory_filings'],
  ['an IFT statistical report', '/ift-statistical-reports', {
    report_period: '2026-Q1', period_start: '2026-01-01', period_end: '2026-03-31', concession_title_id: B_TITLE,
  }, 'ift_statistical_reports'],
])('%s citing another organization\'s concession title is refused', async (_label, path, body, table) => {
  const res = await call('post', path, body);
  expect(res.status).toBe(422);
  expect(inserts(table)).toEqual([]);
  const probe = calls.find(c => /FROM `?concession_titles`?/.test(c.sql));
  expect(probe.params).toEqual(expect.arrayContaining([B_TITLE, ORG]));
});

test.each([
  ['restoring an AP sector config', 'post', '/wireless/ap-sectors/77/restore'],
  ['restoring an AP channel plan', 'post', '/wireless/channel-plans/77/restore'],
  ['verifying an identity record', 'put', '/regulatory-compliance/identity-verification/77/verify'],
  ['rejecting an identity record', 'put', '/regulatory-compliance/identity-verification/77/reject'],
])('%s that is not the caller\'s answers 404', async (_label, method, path) => {
  const res = await call(method, path, {});
  expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 404, code: 'NOT_FOUND' });
});

test('the coverage-zone list returns a boundary mysql2 already decoded', async () => {
  const boundary = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
  rows.coverage_zones = [{ id: 5, organization_id: ORG, name: 'z', boundary }];
  const res = await call('get', '/coverage-zones');
  expect(res.status).toBe(200);
  expect(res.body.data[0].boundary).toEqual(boundary);
});

