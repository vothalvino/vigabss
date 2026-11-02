// =============================================================================
// REG-12 / ASY-25 — service-modification notices
// =============================================================================

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 3; next(); } }));
jest.mock('../src/middleware/orgLocale', () => ({ requireMxLocale: (_req, _res, next) => next() }));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));

const db = require('../src/config/database');
const router = require('../src/routes/consumerProtection');

const app = express();
app.use(express.json());
app.use('/consumer-protection', router);
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } }));

let notice;
beforeEach(() => {
  jest.clearAllMocks();
  notice = { id: 9, status: 'pending', client_id: 5 };
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \?/.test(sql)) return [[{ id: 5 }]];
    if (/FROM contracts WHERE id = \?/.test(sql)) return [[{ id: 8, client_id: 5 }]];
    if (/SELECT id, status, client_id FROM service_modification_notices/.test(sql)) return [[notice]];
    if (/^\s*INSERT INTO service_modification_notices/.test(sql)) return [{ insertId: 9 }];
    if (/^\s*UPDATE service_modification_notices/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
});

const NEW_NOTICE = { notice_type: 'price_change', description: 'New price from March', effective_date: '2026-12-15' };

describe('REG-12 — create and edit', () => {
  test('a minimal notice leaves absent fields to the column defaults', async () => {
    const res = await request(app).post('/consumer-protection/service-modifications').send(NEW_NOTICE);
    expect(res.status).toBe(201);
    const [sql, params] = db.query.mock.calls.find(([q]) => /INSERT INTO service_modification_notices/.test(q));
    expect(sql).not.toMatch(/channel|notice_required_days|status/);
    expect(params).toEqual([3, 'price_change', 'New price from March', '2026-12-15']);
  });

  test.each([
    [{ ...NEW_NOTICE, description: undefined }],
    [{ ...NEW_NOTICE, effective_date: '15/12/2026' }],
    [{ ...NEW_NOTICE, channel: 'fax' }],
  ])('an invalid notice is a 422, not a 500', async (body) => {
    const res = await request(app).post('/consumer-protection/service-modifications').send(body);
    expect(res.status).toBe(422);
  });

  test("another organization's client is refused", async () => {
    db.query.mockImplementation(async (sql) => (/FROM clients WHERE id = \?/.test(sql) ? [[]] : [[]]));
    const res = await request(app).post('/consumer-protection/service-modifications').send({ ...NEW_NOTICE, client_id: 77 });
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([q]) => /INSERT INTO service_modification_notices/.test(q))).toBe(false);
  });

  test('a sent notice cannot be edited', async () => {
    notice.status = 'sent';
    const res = await request(app).put('/consumer-protection/service-modifications/9').send({ description: 'rewritten' });
    expect(res.status).toBe(409);
    expect(db.query.mock.calls.some(([q]) => /^\s*UPDATE service_modification_notices/.test(q))).toBe(false);
  });

  test('a pending notice is edited field by field, and status is not writable', async () => {
    const res = await request(app).put('/consumer-protection/service-modifications/9').send({ description: 'fixed', status: 'acknowledged' });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls.find(([q]) => /^\s*UPDATE service_modification_notices/.test(q));
    expect(sql).toMatch(/SET description = \?, updated_at = NOW\(\)/);
    expect(sql).toMatch(/AND status = 'pending'/);
    expect(params).toEqual(['fixed', '9', 3]);
  });
});

describe('ASY-25 — sending a notice delivers it', () => {
  const emailTransport = require('../src/services/emailTransport');
  const smsTransport = require('../src/services/smsTransport');
  const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);

  function wireSend(row, client = { id: 5, name: 'Ana', email: 'ana@x.mx', phone: '+525512345678' }) {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM service_modification_notices/.test(sql)) return [[row]];
      if (/FROM clients WHERE id = \?/.test(sql)) return [[client]];
      if (/^\s*UPDATE service_modification_notices/.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
  }
  const base = { id: 9, status: 'pending', notice_type: 'price_change', description: 'Nuevo precio', effective_date: future, notice_required_days: 30 };
  const marked = () => db.query.mock.calls.find(([q]) => /SET noticed_at = NOW\(\), status = 'sent'/.test(q));

  afterEach(() => jest.restoreAllMocks());

  test('an email notice to a client is emailed and only then marked sent', async () => {
    wireSend({ ...base, client_id: 5, channel: 'email' });
    const spy = jest.spyOn(emailTransport, 'sendEmail').mockResolvedValue({ success: true, messageId: 'm-1' });
    const res = await request(app).put('/consumer-protection/service-modifications/9/send');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ clientId: 5, messageClass: 'transactional', to: 'ana@x.mx' }));
    expect(marked()).toBeDefined();
  });

  test('a failed delivery leaves the notice pending', async () => {
    wireSend({ ...base, client_id: 5, channel: 'sms' });
    jest.spyOn(smsTransport, 'sendSms').mockResolvedValue({ success: false, error: 'no provider' });
    const res = await request(app).put('/consumer-protection/service-modifications/9/send');
    expect(res.status).toBe(502);
    expect(marked()).toBeUndefined();
  });

  test('a broadcast notice needs delivery evidence and records it', async () => {
    wireSend({ ...base, client_id: null, channel: 'all' });
    const missing = await request(app).put('/consumer-protection/service-modifications/9/send');
    expect(missing.status).toBe(422);
    expect(marked()).toBeUndefined();

    const res = await request(app).put('/consumer-protection/service-modifications/9/send').send({ delivery_evidence: 'Mailed to all subscribers on 2026-11-02' });
    expect(res.status).toBe(200);
    expect(marked()[1][0]).toMatch(/Delivered outside the system: Mailed to all subscribers/);
  });

  test('a notice inside its required notice period is refused', async () => {
    wireSend({ ...base, client_id: 5, channel: 'email', effective_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
    const res = await request(app).put('/consumer-protection/service-modifications/9/send');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOTICE_PERIOD_TOO_SHORT');
  });
});
