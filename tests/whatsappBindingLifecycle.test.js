// =============================================================================
// SUP-04 — a WhatsApp binding ends when it should, and staff can end it
// =============================================================================
// Bindings never expired, nothing revoked them when the client's phone or
// email changed, the portal password was reset, or the client was archived or
// made inactive, and resolveBinding returned any active link without checking
// the client. Only the subscriber (from that phone or the portal) could
// unlink, so a recycled, SIM-swapped or lost number kept reading the account:
// balance and pay link, invoices, tickets, visit requests, Wi-Fi resets.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const emailTransport = require('../src/services/emailTransport');
const auditLog = require('../src/services/auditLog');
const wa = require('../src/services/whatsappService');

const DAY = 86400000;
let link;
let client;
beforeEach(() => {
  jest.clearAllMocks();
  link = { id: 31, client_id: 10, organization_id: 1, bound_at: new Date(Date.now() - 5 * DAY), last_seen_at: new Date(Date.now() - DAY) };
  client = { id: 10, organization_id: 1, name: 'Ana', email: 'ana@example.com', phone: '+525511112222', status: 'active', deleted_at: null };
  db.query.mockImplementation(async (sql) => {
    if (/FROM whatsapp_links\s+WHERE active_phone = \?/.test(sql)) return [[link]];
    if (/SELECT status, deleted_at FROM clients/.test(sql)) return [[client]];
    if (/SELECT name, email FROM clients/.test(sql)) return [[client]];
    if (/FROM `?clients`? WHERE id = \?/.test(sql)) return [[client]];
    if (/FROM whatsapp_links\s+WHERE client_id = \?/.test(sql)) return [[{ id: 31, phone_e164: '+525599998888', bound_via: 'portal' }]];
    if (/COUNT\(\*\)/.test(sql)) return [[{ n: 0, total: 0 }]];
    return [{ affectedRows: 1, insertId: 1 }];
  });
});

const revocations = () => db.query.mock.calls.filter(([sql]) => /UPDATE whatsapp_links SET status = 'revoked'/.test(sql));

describe('resolveBinding', () => {
  test('a live, recently used binding resolves', async () => {
    await expect(wa.resolveBinding('+525599998888')).resolves.toEqual({ clientId: 10, organizationId: 1, linkId: 31 });
    expect(revocations()).toHaveLength(0);
  });

  test.each([
    ['archived', () => { client.deleted_at = new Date(); }],
    ['inactive', () => { client.status = 'inactive'; }],
    ['unused past the idle window', () => { link.last_seen_at = new Date(Date.now() - 400 * DAY); }],
  ])('a binding whose client is %s no longer resolves and is revoked', async (_label, arrange) => {
    arrange();
    await expect(wa.resolveBinding('+525599998888')).resolves.toBeNull();
    expect(revocations()).toHaveLength(1);
  });
});

test('binding a number emails the account owner', async () => {
  const conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(), execute: jest.fn().mockResolvedValue([{ insertId: 32 }]) };
  db.getConnection.mockResolvedValue(conn);
  await wa.bindNumber({ organizationId: 1, clientId: 10, phone: '+525599998888', via: 'email_otp' });
  expect(emailTransport.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
    to: 'ana@example.com', messageClass: 'security', html: expect.stringContaining('8888'),
  }));
});

describe('changes that end a binding', () => {
  const app = require('../src/app');
  const clientRevokes = () => revocations().filter(([sql]) => /WHERE client_id = \?/.test(sql));

  test.each([
    ['a phone change', { phone: '+525500001111' }],
    ['an email change', { email: 'new@example.com' }],
    ['making the client inactive', { status: 'inactive' }],
  ])('%s revokes the client bindings', async (_label, body) => {
    await request(app).put('/api/v1/clients/10').send(body);
    expect(clientRevokes()).toHaveLength(1);
    expect(clientRevokes()[0][1]).toEqual([10, 1]);
  });

  test('an unrelated edit leaves bindings alone', async () => {
    await request(app).put('/api/v1/clients/10').send({ name: 'Ana María', phone: '+525511112222' });
    expect(clientRevokes()).toHaveLength(0);
  });

  test('archiving the client revokes its bindings', async () => {
    await request(app).delete('/api/v1/clients/10');
    expect(clientRevokes()).toHaveLength(1);
  });

  test('a portal password reset revokes the bindings', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM clients\s+WHERE portal_reset_token_hash/.test(sql)) return [[{ ...client }]];
      if (/FROM organization_database_configs/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    });
    await require('../src/services/portalAuthService').resetPassword('reset-token', 'a-new-password');
    expect(clientRevokes()).toHaveLength(1);
  });
});

describe('staff can list and end bindings', () => {
  const app = require('../src/app');

  test('GET /clients/:id/whatsapp-links lists them', async () => {
    const res = await request(app).get('/api/v1/clients/10/whatsapp-links');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ id: 31, phone_e164: '+525599998888' })]);
  });

  test('DELETE revokes one and is audited', async () => {
    const res = await request(app).delete('/api/v1/clients/10/whatsapp-links/31');
    expect(res.status).toBe(204);
    expect(revocations()[0][1]).toEqual(['31', 10, 1]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'whatsapp_link_revoked', recordId: 31 }));
  });

  test("another organization's client is a 404", async () => {
    db.query.mockImplementation(async () => [[]]);
    const res = await request(app).delete('/api/v1/clients/99/whatsapp-links/31');
    expect(res.status).toBe(404);
    expect(revocations()).toHaveLength(0);
  });
});
