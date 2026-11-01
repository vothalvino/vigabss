// =============================================================================
// CFD-09 — SAT stamps and cancellations are attributed to a user
// =============================================================================
// cfdiService wrote no audit entry for a stamp or a cancellation, and the
// cfdi_cancellations INSERT left requested_by_user_id out, so an irreversible
// fiscal act (a cancellation with a given motivo, a stamp from the CFDI page)
// could not be traced to the person who did it.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/billingService', () => ({ cancelInvoiceForSat: jest.fn().mockResolvedValue({}) }));

const db = require('../src/config/database');
const auditLog = require('../src/services/auditLog');
const cfdiService = require('../src/services/cfdiService');

// 'dev_placeholder' is an unknown provider: outside production it stamps with a
// placeholder UUID and simulates an accepted cancellation.
const PAC = { id: 2, provider_name: 'dev_placeholder', organization_id: 1, status: 'active', environment: 'sandbox' };

beforeEach(() => {
  jest.clearAllMocks();
  cfdiService._resetProviderBreakers();
});

describe('cancel()', () => {
  const DOC = { id: 7, organization_id: 1, invoice_id: 55, uuid: 'UUID-VIGENTE-1', sat_status: 'vigente', tipo_comprobante: 'I' };

  beforeEach(() => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) return [[DOC]];
      if (/SELECT invoice_id, .*FROM cfdi_documents/.test(sql)) return [[DOC]];
      if (/FROM pac_providers/.test(sql)) return [[PAC]];
      if (/INSERT INTO cfdi_cancellations/.test(sql)) return [{ insertId: 900 }];
      if (/^\s*UPDATE cfdi_documents/.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    });
  });

  test('records who asked, with the motivo, and how SAT answered', async () => {
    await cfdiService.cancel(7, '01', 'AAAA-REPL', { userId: 8 });

    const [sql, params] = db.query.mock.calls.find(([q]) => /INSERT INTO cfdi_cancellations/.test(q));
    expect(sql).toMatch(/requested_at, requested_by_user_id, pac_provider_id\)\s+VALUES \(\?, \?, \?, \?, \?, 'pending', NOW\(\), \?, \?\)/);
    expect(params).toEqual([7, 1, 'UUID-VIGENTE-1', '01', 'AAAA-REPL', 8, 2]);

    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 8, organizationId: 1, action: 'cfdi_cancel_requested', recordId: 7,
      newValues: expect.objectContaining({ uuid: 'UUID-VIGENTE-1', motivo: '01', folio_sustitucion: 'AAAA-REPL', cancellation_id: 900 }),
    }));
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 8, action: 'cfdi_cancel_resolved', newValues: expect.objectContaining({ status: 'accepted', motivo: '01' }),
    }));
  });

  test('a later SAT answer is attributed to whoever requested the cancellation', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM cfdi_cancellations/.test(sql)) {
        return [[{ id: 900, cfdi_document_id: 7, organization_id: 1, uuid: 'UUID-VIGENTE-1', motivo: '02', cancellation_status: 'pending', pac_provider_id: 2, requested_by_user_id: 8 }]];
      }
      if (/FROM pac_providers/.test(sql)) return [[PAC]];
      if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
      return [[DOC]];
    });
    await cfdiService.getCancellationStatus(900);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 8, action: 'cfdi_cancel_resolved', recordId: 7,
      newValues: expect.objectContaining({ status: 'accepted', motivo: '02', cancellation_id: 900 }),
    }));
  });
});

describe('stamp()', () => {
  test('records who stamped and the UUID SAT issued', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id = \?/.test(sql)) {
        return [[{ id: 1, organization_id: 1, xml_content: '<cfdi/>', sat_status: 'draft', tipo_comprobante: 'I', serie: 'A', folio: 3 }]];
      }
      if (/pac_environment/.test(sql)) return [[{ pac_environment: 'sandbox' }]];
      if (/FROM pac_providers/.test(sql)) return [[PAC]];
      return [{ affectedRows: 1 }];
    });
    const res = await cfdiService.stamp(1, { userId: 8 });
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      userId: 8, organizationId: 1, action: 'cfdi_stamped', recordId: 1,
      newValues: expect.objectContaining({ uuid: res.uuid, serie: 'A', folio: 3, pac: 'dev_placeholder' }),
    }));
  });
});

describe('the routes pass the caller', () => {
  test.each([
    ['../src/controllers/cfdiController', /cfdiService\.stamp\(cfdi_document_id, \{ userId: req\.user\?\.id \?\? null \}\)/],
    ['../src/controllers/cfdiController', /cfdiService\.cancel\(cfdi_document_id, reason, replacement_uuid, \{ userId: req\.user\?\.id \?\? null \}\)/],
    ['../src/routes/cfdiDocuments', /cfdiService\.cancel\(req\.params\.id, cancellation_reason, replacement_uuid \|\| null, \{ userId: req\.user\?\.id \?\? null \}\)/],
  ])('%s', (mod, re) => {
    expect(require('fs').readFileSync(require.resolve(mod), 'utf8')).toMatch(re);
  });
});
