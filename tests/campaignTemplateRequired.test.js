// =============================================================================
// ASY-21 — a campaign never sends a blank message
// =============================================================================
// The form offered "— No template —", the API made template_id optional and
// dispatch never checked it. processQueue started from subject "Mensaje de su
// proveedor" and an empty body and only filled them from an active same-org or
// global template, so a campaign without one (or with an inactive, deleted or
// foreign one) emailed every consenting client a blank message. scheduled_at
// was accepted and never read.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/services/smsTransport', () => ({ sendSms: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  getOrganizationDeliveryState: jest.fn().mockResolvedValue({ active: true, epoch: 0 }),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const emailTransport = require('../src/services/emailTransport');
const campaignService = require('../src/services/campaignService');

const TEMPLATES = {
  5: { id: 5, channel: 'email', body: 'Hola {{name}}' },
  6: { id: 6, channel: 'sms', body: 'Hola' },
  7: { id: 7, channel: 'email', body: '   ' },
};

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM message_templates/.test(sql)) return [TEMPLATES[params[0]] ? [TEMPLATES[params[0]]] : []];
    if (/^\s*SELECT/i.test(sql)) return [[{ id: 1, name: 'Promo', channel: 'email', template_id: 5 }]];
    return [{ insertId: 1, affectedRows: 1 }];
  });
});

describe('assertUsableTemplate', () => {
  test.each([
    ['no template', 'email', null, /needs an active message template/],
    ['an inactive, deleted or foreign template', 'email', 99, /active template of this organization/],
    ['a template for another channel', 'email', 6, /sms template; this campaign sends email/],
    ['a template with an empty body', 'email', 7, /no body/],
  ])('refuses %s', async (_label, channel, templateId, message) => {
    await expect(campaignService.assertUsableTemplate(1, channel, templateId))
      .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(message) });
  });

  test('accepts an active template of the channel', async () => {
    await expect(campaignService.assertUsableTemplate(1, 'email', 5)).resolves.toMatchObject({ id: 5 });
  });
});

test('dispatch refuses a campaign without a template before queuing anyone', async () => {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
    execute: jest.fn(async (sql) => (/FROM communication_campaigns/.test(sql)
      ? [[{ id: 3, organization_id: 1, channel: 'email', status: 'draft', template_id: null }]]
      : [[]])),
  };
  db.getConnection.mockResolvedValue(conn);
  await expect(campaignService.dispatchCampaign(3, 1)).rejects.toMatchObject({ statusCode: 422 });
  expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO campaign_messages/.test(sql))).toBe(false);
  expect(conn.rollback).toHaveBeenCalled();
});

test('a queued message whose template disappeared fails instead of sending blank', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM organization_database_configs/.test(sql)) return [[]];
    if (/SELECT cm\.\*, cc\.template_id AS campaign_template_id/.test(sql)) {
      return [[{ id: 10, campaign_id: 1, campaign_org_id: 1, campaign_template_id: 5, organization_epoch: 0,
        client_contact_epoch: 1, channel: 'email', recipient: 'ana@example.com', client_id: 1 }]];
    }
    if (/FROM message_templates/.test(sql)) return [[]]; // deactivated after dispatch
    return [{ affectedRows: 1 }];
  });
  await campaignService.processQueue();
  expect(emailTransport.sendEmail).not.toHaveBeenCalled();
  const failedRow = db.query.mock.calls.find(([sql, params]) => /SET status = 'failed', error_message = \?/.test(sql)
    && /Template missing or inactive/.test(params[0]));
  expect(failedRow).toBeDefined();
});

describe('/communication-campaigns', () => {
  const app = require('../src/app');

  test('creating a campaign without a template is refused', async () => {
    const res = await request(app).post('/api/v1/communication-campaigns').send({ name: 'Promo', channel: 'email' });
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO `?communication_campaigns/.test(sql))).toBe(false);
  });

  test('scheduled_at is not stored: nothing would dispatch it', async () => {
    const res = await request(app).post('/api/v1/communication-campaigns')
      .send({ name: 'Promo', channel: 'email', template_id: 5, scheduled_at: '2026-12-01 09:00:00' });
    expect(res.status).toBe(201);
    const [sql] = db.query.mock.calls.find(([q]) => /INSERT INTO `?communication_campaigns/.test(q));
    expect(sql).not.toMatch(/scheduled_at/);
  });
});
