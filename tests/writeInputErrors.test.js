'use strict';
// =============================================================================
// Write routes answer bad input with a 4xx, not a 500
// =============================================================================
// The real-database write sweep sent every write route a body built from its
// validator, and 20 answered 500: a NOT NULL column the schema did not
// require, a missing field bound as undefined, a CHECK constraint, an ENUM the
// schema did not restrict, a "not found" thrown as a plain Error, a payment
// provider's refusal. These drive the real routers against a fake database
// and assert the 4xx and that nothing was inserted.
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

// [label, method, path, body, status, table that must not be inserted into]
const REFUSED = [
  ['an expense without expense_date', 'post', '/expenses', { category: 'fuel', amount: 10 }, 422, 'expenses'],
  ['a link from a device to itself', 'post', '/network-links', { device_a_id: 5, device_b_id: 5 }, 422, 'network_links'],
  ['a notification channel of an unknown type', 'post', '/alerts/notification-channels', { name: 'n', channel_type: 'pagerduty' }, 422, 'alert_notification_channels'],
  ['a late fee rule without a name', 'post', '/late-fee-rules', { fee_amount: 5 }, 422, 'late_fee_rules'],
  ['a late fee rule of an unknown type', 'post', '/late-fee-rules', { name: 'r', fee_type: 'daily' }, 422, 'late_fee_rules'],
  ['a 6rd tunnel without its border relay', 'post', '/transition-mechanisms/6rd', { name: 't', ipv6_prefix: '2001:db8::/32' }, 422, 'tunnel_6rd_configs'],
  ['a DS-Lite config without its AFTR', 'post', '/transition-mechanisms/ds-lite', { name: 't' }, 422, 'ds_lite_configs'],
  ['a MAP rule without its prefixes', 'post', '/transition-mechanisms/map-rules', { name: 't' }, 422, 'map_rules'],
  ['a 464XLAT config without its PLAT prefix', 'post', '/transition-mechanisms/464xlat', { name: 't' }, 422, 'xlat464_configs'],
  ['a link plan without a name or frequency', 'post', '/wireless/link-planning', { lat_a: 1, lon_a: 1, lat_b: 2, lon_b: 2 }, 422, 'link_planning_calcs'],
  ['a USO obligation without its type and period', 'post', '/universal-service/uso-obligations', { description: 'd' }, 422, 'uso_obligations'],
  ['a rural coverage report without a period', 'post', '/universal-service/rural-coverage', { locality_name: 'x', service_type: 'fiber' }, 422, 'rural_coverage_reports'],
  ['a firewall rule without a name', 'post', '/network-security/firewall-rules', { action: 'deny', protocol: 'tcp' }, 422, 'firewall_rules'],
  ['a coverage zone without a service area', 'post', '/coverage-zones', { name: 'z', boundary: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } }, 422, 'coverage_zones'],
  ['a VLAN without a site', 'post', '/vlans', { vlan_id: 10, name: 'v' }, 422, 'vlans'],
  ['an SLA without a plan', 'post', '/sla-definitions', { name: 's' }, 422, 'sla_definitions'],
  ['a credit note without a reason', 'post', '/credit-notes', { client_id: 3 }, 422, 'credit_notes'],
  ['a service area without a boundary', 'post', '/service-areas', { name: 'a' }, 422, 'service_areas'],
];

test.each(REFUSED)('%s is refused (%s %s)', async (_label, method, path, body, status, table) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(status);
  expect(inserts(table)).toEqual([]);
});

// [label, method, path, body] — the id names nothing of this organization.
const NOT_FOUND = [
  ['a checkout session for an unknown invoice', 'post', '/checkout/session', { invoice_id: 77, client_id: 3 }],
  ['a payment link for an unknown invoice', 'post', '/checkout/payment-link', { invoice_id: 77 }],
  ['dispatching an unknown campaign', 'post', '/communication-campaigns/77/dispatch', {}],
  ['replacing an unknown USO obligation', 'put', '/universal-service/uso-obligations/77', {
    obligation_type: 'universal_service', description: 'd', period_start: '2026-01-01', period_end: '2026-12-31',
  }],
  ['replacing an unknown rural coverage report', 'put', '/universal-service/rural-coverage/77', {
    report_period: '2026-01', locality_name: 'x', service_type: 'fiber',
  }],
  ['updating a data residency config that was never created', 'put', '/data-residency', { primary_storage_country: 'MX' }],
  ['an AP sector on an unknown device', 'post', '/wireless/ap-sectors', { device_id: 77, sector_name: 's' }],
];

test.each(NOT_FOUND)('%s answers 404 (%s %s)', async (_label, method, path, body) => {
  const res = await call(method, path, body);
  expect({ status: res.status, code: res.body?.error?.code }).toEqual({ status: 404, code: 'NOT_FOUND' });
});

test('an IP pool without ip_version is checked for overlap as IPv4', async () => {
  const res = await call('post', '/ip-pools', { name: 'p', network: '10.0.0.0', subnet_mask: '255.255.255.0' });
  expect(res.status).not.toBe(500);
  const overlap = calls.find(c => /FROM ip_pools WHERE deleted_at IS NULL AND ip_version = \?/.test(c.sql));
  expect(overlap.params).toEqual(['4', ORG]);
});

test('a data residency config without a storage country defaults to MX', async () => {
  const res = await call('post', '/data-residency', { cross_border_destinations: ['US'] });
  expect(res.status).toBe(201);
  const insert = inserts('data_residency_config')[0];
  expect(insert.params.slice(0, 2)).toEqual([ORG, 'MX']);
  expect(insert.params).toContain('["US"]');
});

test('a service area stores its GeoJSON boundary as a polygon', async () => {
  rows.service_areas = [{ id: 900, organization_id: ORG, name: 'a', status: 'planned' }];
  const boundary = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] };
  const res = await call('post', '/service-areas', { name: 'a', boundary });
  expect(res.status).toBe(201);
  const insert = inserts('service_areas')[0];
  expect(insert.sql).toMatch(/ST_GeomFromGeoJSON\(\?, 1, 4326\)/);
  expect(insert.params).toContain(JSON.stringify(boundary));
});

test('a contract add-on without a price or start date takes the catalog price and today', async () => {
  rows.contracts = [{ id: 8, organization_id: ORG }];
  rows.plan_addons = [{ id: 4, price: '99.00' }];
  const res = await call('post', '/contracts/8/addons', { plan_addon_id: 4 });
  expect(res.status).toBe(201);
  const [, , , price, start, end] = inserts('contract_addons')[0].params;
  expect({ price, end }).toEqual({ price: '99.00', end: null });
  expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('a credit note without a number gets the next NC number on its own transaction', async () => {
  rows.clients = [{ id: 3, organization_id: ORG }];
  rows.credit_notes = [{ id: 900, organization_id: ORG, status: 'draft' }];
  const res = await call('post', '/credit-notes', {
    client_id: 3, reason: 'other', subtotal: 100, tax_rate: 0.16, tax_amount: 16, total: 116,
  });
  expect(res.status).toBe(201);
  expect(calls.some(c => /INSERT INTO organization_credit_note_sequences/.test(c.sql))).toBe(true);
  const insert = inserts('credit_notes')[0];
  expect(insert.params).toContain('NC-000001');
});

describe('a payment provider refusal', () => {
  const https = require('https');
  const { EventEmitter } = require('events');
  const paymentGatewayService = require('../src/services/paymentGatewayService');
  const encryption = require('../src/utils/encryption');

  test('is a 502 PAYMENT_GATEWAY_ERROR, and the provider message stays out of it', async () => {
    jest.spyOn(encryption, 'decrypt').mockReturnValue('sk_test_revoked');
    jest.spyOn(https, 'request').mockImplementation((_opts, onResponse) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 401;
        onResponse(res);
        res.emit('data', JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_****oked' } }));
        res.emit('end');
      };
      req.destroy = () => {};
      return req;
    });
    const err = await paymentGatewayService.createStripeCustomer({ secret_key_encrypted: 'x' }, { email: 'a@example.com' })
      .catch(e => e);
    expect({ statusCode: err.statusCode, code: err.code }).toEqual({ statusCode: 502, code: 'PAYMENT_GATEWAY_ERROR' });
    expect(err.message).not.toMatch(/API Key|sk_test/);
  });
});
