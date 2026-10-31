// =============================================================================
// CFD-02 — a draft CFDI whose stamp was refused can be fixed
// =============================================================================
// Retrying a draft resent the XML it was built with (same Fecha, receptor,
// UsoCFDI and conceptos), drafts could not be rebuilt or deleted, and a draft
// froze its invoice. A timeout after the PAC stamped left no trace. Drafts
// can now be discarded or rebuilt from the invoice — only when the last
// attempt was definitely refused — and every failed attempt is recorded.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/models/User');

const db = require('../src/config/database');
const cfdiService = require('../src/services/cfdiService');
const invoiceCfdiService = require('../src/services/invoiceCfdiService');

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
  db.getConnection.mockReset();
  cfdiService.circuitBreaker.failures = 0;
  cfdiService.circuitBreaker.lastFailure = 0;
});

function lockedDoc(row) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(), release: jest.fn(),
    execute: jest.fn(async (sql) => {
      if (/FOR UPDATE/.test(sql)) return [row ? [row] : []];
      return [{ affectedRows: 1 }];
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  return conn;
}
const deleted = conn => conn.execute.mock.calls.some(([sql]) => /^DELETE FROM cfdi_documents/.test(sql));

describe('discardDraft', () => {
  const draft = { id: 7, organization_id: 1, sat_status: 'draft', uuid: null, stamp_ambiguous: 0, invoice_id: 55, serie: 'A', folio: 12 };

  test('deletes a refused draft under a lock, scoped to the organization', async () => {
    const conn = lockedDoc(draft);
    const result = await cfdiService.discardDraft(7, 1, { userId: 3 });
    expect(conn.execute.mock.calls[0][1]).toEqual([7, 1]);
    expect(deleted(conn)).toBe(true);
    expect(conn.commit).toHaveBeenCalled();
    expect(result).toEqual({ cfdi_document_id: 7, invoice_id: 55, discarded: true });
  });

  test('refuses a draft whose last attempt may have been stamped', async () => {
    const conn = lockedDoc({ ...draft, stamp_ambiguous: 1 });
    await expect(cfdiService.discardDraft(7, 1)).rejects.toMatchObject({ statusCode: 409, code: 'CFDI_STAMP_UNCONFIRMED' });
    expect(deleted(conn)).toBe(false);
  });

  test.each([
    ['a stamped CFDI', { sat_status: 'vigente', uuid: 'U-1' }],
    ['a cancelled CFDI', { sat_status: 'cancelado', uuid: 'U-1' }],
  ])('refuses %s', async (_label, over) => {
    const conn = lockedDoc({ ...draft, ...over });
    await expect(cfdiService.discardDraft(7, 1)).rejects.toMatchObject({ statusCode: 409, code: 'CFDI_NOT_DRAFT' });
    expect(deleted(conn)).toBe(false);
  });

  test("another organization's draft is a 404", async () => {
    lockedDoc(null);
    await expect(cfdiService.discardDraft(7, 2)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('rebuildDraft', () => {
  test('discards the draft and converts the invoice again', async () => {
    db.query.mockResolvedValueOnce([[{ id: 7, invoice_id: 55, tipo_comprobante: 'I' }]]);
    const discard = jest.spyOn(cfdiService, 'discardDraft').mockResolvedValue({ discarded: true });
    // stampInvoice's first step: the emisor profile. Stop there.
    jest.spyOn(cfdiService, 'getEmisorProfile').mockRejectedValue(Object.assign(new Error('stop'), { statusCode: 422 }));

    await expect(invoiceCfdiService.rebuildDraft(7, 1, { userId: 3 })).rejects.toThrow('stop');

    expect(discard).toHaveBeenCalledWith(7, 1, { userId: 3 });
  });

  test('a draft that is not an invoice CFDI cannot be rebuilt', async () => {
    db.query.mockResolvedValueOnce([[{ id: 8, invoice_id: null, tipo_comprobante: 'P' }]]);
    const discard = jest.spyOn(cfdiService, 'discardDraft');
    await expect(invoiceCfdiService.rebuildDraft(8, 1)).rejects.toMatchObject({ statusCode: 422, code: 'CFDI_NOT_REBUILDABLE' });
    expect(discard).not.toHaveBeenCalled();
  });
});

describe('stamp attempts are recorded', () => {
  const doc = { id: 9, organization_id: 1, xml_content: '<cfdi/>', invoice_id: null };

  test('the draft is marked possibly-stamped before the PAC call and stays so after a timeout', async () => {
    const pac = { id: 4, provider_name: 'sw_sapien', seal_mode: 'pac', token_encrypted: 'tok', status: 'active', environment: 'sandbox', api_url: 'http://127.0.0.1:9' };
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return [[doc]];
      if (/pac_environment/.test(sql)) return [[{ pac_environment: 'sandbox' }]];
      if (/FROM pac_providers/.test(sql)) return [[pac]];
      return [{ affectedRows: 1 }];
    });
    // A request that went out and never got an answer.
    const timeout = Object.assign(new Error('socket hang up / timeout'), { code: 'ETIMEDOUT' });
    jest.spyOn(require('https'), 'request').mockImplementation(() => { throw timeout; });
    jest.spyOn(require('http'), 'request').mockImplementation(() => { throw timeout; });

    await expect(cfdiService.stamp(9)).rejects.toThrow(/PAC stamping failed/);

    const marker = db.query.mock.calls.findIndex(([sql]) => /SET stamp_ambiguous = 1/.test(sql));
    const firstPacCall = db.query.mock.calls.findIndex(([sql]) => /FROM pac_providers/.test(sql));
    expect(marker).toBeGreaterThan(firstPacCall);
    const [, params] = db.query.mock.calls.find(([sql]) => /SET stamp_error = \?/.test(sql));
    expect(params[1]).toBe(1); // ambiguous: it may have been stamped
  });

  test('a stamp racing a discard stops before reaching the PAC', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return [[doc]];
      if (/pac_environment/.test(sql)) return [[{ pac_environment: 'sandbox' }]];
      if (/FROM pac_providers/.test(sql)) return [[{ id: 4, provider_name: 'simulator', environment: 'sandbox', status: 'active' }]];
      if (/SET stamp_ambiguous = 1/.test(sql)) return [{ affectedRows: 0 }];
      return [{ affectedRows: 1 }];
    });
    await expect(cfdiService.stamp(9)).rejects.toMatchObject({ statusCode: 409, code: 'CFDI_NOT_DRAFT' });
  });
});

describe('routes', () => {
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const config = require('../src/config');
  const User = require('../src/models/User');
  const app = require('../src/app');
  const token = jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
  const call = (method, path, body) => request(app)[method](`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

  const cfdiFeature = config.features.cfdi;
  beforeAll(() => { config.features.cfdi = true; });
  afterAll(() => { config.features.cfdi = cfdiFeature; });

  beforeEach(() => {
    User.findById.mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
    db.query.mockResolvedValue([[]]);
    // CFDI routes are MX-only.
    jest.spyOn(require('../src/models/Organization'), 'getLocale').mockResolvedValue('MX');
  });

  test('DELETE /cfdi-documents/:id discards the draft for the caller organization', async () => {
    const discard = jest.spyOn(cfdiService, 'discardDraft').mockResolvedValue({ cfdi_document_id: 7, invoice_id: 55, discarded: true });
    const res = await call('delete', '/cfdi-documents/7');
    expect(res.status).toBe(200);
    expect(discard).toHaveBeenCalledWith('7', 1, { userId: 1 });
  });

  test('a bare POST /cfdi-documents linked to an invoice is refused', async () => {
    const res = await call('post', '/cfdi-documents', { client_id: 2, invoice_id: 55, tipo_comprobante: 'I' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_INVOICE_LINK_NOT_ALLOWED');
  });
});
