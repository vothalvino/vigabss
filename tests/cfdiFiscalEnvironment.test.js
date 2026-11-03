'use strict';
// =============================================================================
// CFD-13 — a CFDI keeps the fiscal environment that stamped it
// =============================================================================
// cfdi_documents.pac_environment records sandbox or production at stamping
// (migration 500), but cancellation still picked PACs by the organization's
// current switch, so a sandbox CFDI could not be cancelled after going live
// and a production one would be sent to sandbox after switching back. A
// sandbox CFDI also blocked voiding its invoice and its UUID went into the tax
// report as if SAT had seen it.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn() }));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const cfdiService = require('../src/services/cfdiService');
const billingService = require('../src/services/billingService');
const app = require('../src/app');

const AUTH = 'Bearer ' + jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });

beforeEach(() => {
  jest.resetAllMocks();
  cfdiService._resetProviderBreakers();
  User.findById.mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

test('a sandbox CFDI is cancelled through a sandbox PAC after the organization went live', async () => {
  const doc = { id: 1, organization_id: 1, uuid: 'SIMULADO-1', sat_status: 'vigente', pac_environment: 'sandbox' };
  db.query.mockImplementation(async (sql) => {
    if (/FROM cfdi_documents WHERE id = \?/.test(sql)) return [[doc]];
    if (/FROM organization_mx_profiles/.test(sql)) return [[{ pac_environment: 'production' }]];
    if (/FROM pac_providers/.test(sql)) return [[]];
    return [[]];
  });

  await expect(cfdiService.cancel(1, '02')).rejects.toMatchObject({ code: 'CFDI_NO_ACTIVE_PAC' });

  const pacLookup = db.query.mock.calls.find(([sql]) => /FROM pac_providers/.test(sql));
  expect(pacLookup[1]).toEqual([1, 'sandbox']);
  expect(db.query.mock.calls.some(([sql]) => /FROM organization_mx_profiles/.test(sql))).toBe(false);
});

test('a sandbox CFDI does not block voiding its invoice; a production or draft one does', async () => {
  db.query.mockResolvedValueOnce([[{ id: 3, sat_status: 'vigente' }]]);
  await expect(billingService.voidInvoiceById(9, 1, 1)).rejects.toMatchObject({ code: 'INVOICE_STAMPED' });

  const [sql, params] = db.query.mock.calls[0];
  expect(params).toEqual([9, 1]);
  expect(sql).toMatch(/sat_status = 'draft'/);
  expect(sql).toMatch(/sat_status IN \('vigente', 'cancel_pending'\) AND NOT \(pac_environment <=> 'sandbox'\)/);
});

test('the tax report only carries UUIDs of production CFDIs', async () => {
  db.query.mockResolvedValue([[]]);

  for (const type of ['invoices', 'credit_notes']) {
    const res = await request(app).get(`/api/v1/billing/tax-reports?type=${type}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
  }

  const joins = db.query.mock.calls.map(([sql]) => sql).filter((sql) => /LEFT JOIN cfdi_documents cd/.test(sql));
  expect(joins).toHaveLength(2);
  for (const sql of joins) expect(sql).toMatch(/LEFT JOIN cfdi_documents cd ON [^\n]+\n\s+AND cd\.pac_environment = 'production'/);
});

test('the environment endpoint reports sandbox CFDIs still marked vigente', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/SELECT locale FROM organizations/i.test(sql)) return [[{ locale: 'MX' }]]; // the cfdi feature gate
    if (/FROM organization_mx_profiles/.test(sql)) return [[{ pac_environment: 'sandbox' }]];
    if (/COUNT\(\*\) AS n FROM cfdi_documents/.test(sql)) return [[{ n: 4 }]];
    return [[]];
  });

  const res = await request(app).get('/api/v1/pac-providers/environment').set('Authorization', AUTH);

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ pac_environment: 'sandbox', sandbox_vigente_count: 4 });
});
