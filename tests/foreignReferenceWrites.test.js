// =============================================================================
// TNB-28 — create/update paths refuse another tenant's linked rows
// =============================================================================
// crudController.create injected organization_id but checked no foreign id,
// and several custom routes did the same: an outage on another tenant's site,
// a network link to its devices, an autopay profile on its client and
// gateway, a NAS whose failover target is its NAS (CoA'd with that NAS's own
// secret), a payment plan for another client's invoice, phone numbers,
// dependency edges, CPE scans and identity records for its subscribers.
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
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'u@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
  .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

// Every ownership probe answers "not this organization's"; anything else is empty.
beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/^\s*(INSERT|UPDATE)/.test(sql) ? [{ insertId: 7, affectedRows: 1 }] : [[]]));
  User.findById.mockResolvedValue({ id: 1, email: 'u@test.com', status: 'active', role: 'admin', organization_id: 1 });
});
const wrote = table => db.query.mock.calls.some(([sql]) => new RegExp(`^\\s*(INSERT INTO|UPDATE) ${table}\\b`).test(sql));
const probed = table => db.query.mock.calls.some(([sql]) => new RegExp(`^SELECT id FROM ${table} WHERE id = \\?`).test(sql));

test.each([
  ['post', '/outages', { title: 'Fiber cut', started_at: '2026-10-31T10:00:00Z', site_id: 900 }, 'outages', 'sites'],
  ['post', '/network-links', { device_a_id: 900, device_b_id: 901 }, 'network_links', 'devices'],
  ['post', '/recurring-payment-profiles', { client_id: 900, payment_gateway_id: 901, token_reference: 'tok' }, 'recurring_payment_profiles', 'clients'],
  ['post', '/nas', { name: 'edge', ip_address: '10.0.0.9', secret: 's', secondary_nas_id: 900 }, 'nas', 'nas'],
  ['post', '/payment-plans', { client_id: 900, total_amount: 300, installment_count: 3, frequency: 'monthly' }, 'payment_plans', 'clients'],
  ['post', '/numbering-management/phone-numbers', { phone_number: '5551234567', client_id: 900 }, 'phone_number_inventory', 'clients'],
  ['post', '/topology/dependencies', { parent_device_id: 900, child_device_id: 901 }, 'device_dependency_edges', 'devices'],
  ['post', '/network-security/cpe-security-scans', { scan_type: 'open_ports', device_id: 900 }, 'cpe_security_scans', 'devices'],
  ['post', '/regulatory-compliance/identity-verification', { client_id: 900, id_type: 'INE', id_number: 'X', verification_method: 'manual' }, 'identity_verification_records', 'clients'],
])('%s %s with another tenant\'s id is refused before writing', async (method, path, body, table, refTable) => {
  const res = await call(method, path, body);
  expect(res.status).toBe(422);
  expect(probed(refTable)).toBe(true);
  expect(wrote(table)).toBe(false);
});

test('a payment plan cannot split another client\'s invoice', async () => {
  const { createPlan } = require('../src/services/paymentPlanService');
  db.query.mockImplementation(async () => [[{ id: 50, client_id: 6, total: '250.00' }]]);
  await expect(createPlan({ organizationId: 1, clientId: 5, invoiceId: 50, installmentCount: 2, frequency: 'monthly', createdBy: 1 }))
    .rejects.toMatchObject({ statusCode: 422 });
});
