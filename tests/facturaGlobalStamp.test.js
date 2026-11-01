// =============================================================================
// BIL-24 — a factura pública becomes a real factura global
// =============================================================================
// InformacionGlobal was always Periodicidad 01 with Meses/Año from the CFDI
// date, for any XAXX receptor; factura_publica_invoices stored a period that
// nothing ever turned into a CFDI.

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn(async () => {}) }));

const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const cfdiService = require('../src/services/cfdiService');
const facturaPublicaService = require('../src/services/facturaPublicaService');
const { globalPeriodProblem } = require('../src/utils/satCatalogs');

const EMISOR = { rfc: 'EKU9003173C9', razon_social: 'ESCUELA KEMPER URGATE', regimen_fiscal: '601', codigo_postal_fiscal: '26015', cfdi_serie_ingreso: 'A' };
const FACTURA = { id: 3, organization_id: 1, status: 'draft', cfdi_document_id: null, periodicidad: '04', meses: '10', anio: 2026 };
const INVOICES = [
  { id: 11, invoice_number: 'INV-11', status: 'paid', subtotal: '100.00', tax_amount: '16.00', total: '116.00', tax_rate: '0.1600', currency: 'MXN' },
  { id: 12, invoice_number: 'INV-12', status: 'paid', subtotal: '200.00', tax_amount: '32.00', total: '232.00', tax_rate: '0.1600', currency: 'MXN' },
];

let conn;
function wire({ factura = FACTURA, invoices = INVOICES, ownCfdi = [], payments = [{ sat_forma_pago: null, payment_method: 'cash', amount: '300.00' }] } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM factura_publica_invoices WHERE id = \? AND organization_id = \? FOR UPDATE/.test(sql)) return [[factura]];
    if (/FROM factura_publica_invoice_items fi/.test(sql)) return [invoices];
    if (/SELECT invoice_id FROM cfdi_documents/.test(sql)) return [ownCfdi];
    if (/FROM payment_allocations pa/.test(sql)) return [payments];
    if (/LAST_INSERT_ID\(\) AS folio/.test(sql)) return [[{ folio: 77 }]];
    if (/^\s*INSERT INTO cfdi_documents/.test(sql)) return [{ insertId: 900 }];
    if (/^\s*INSERT INTO cfdi_conceptos/.test(sql)) return [{ insertId: 1000 }];
    return [{ affectedRows: 1 }];
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  conn = mockTxConnection(db);
  jest.spyOn(cfdiService, 'getEmisorProfile').mockResolvedValue({ ...EMISOR });
  jest.spyOn(cfdiService, 'generateXml').mockResolvedValue({ xml: '<x/>' });
  jest.spyOn(cfdiService, 'stamp').mockResolvedValue({ uuid: 'UUID-G', status: 'vigente' });
});

const onTx = re => conn.execute.mock.calls.filter(([sql]) => re.test(sql));

test('builds one PUBLICO EN GENERAL CFDI with the record period and one concepto per invoice', async () => {
  wire();
  const result = await facturaPublicaService.stampGlobal(3, 1, { userId: 5 });

  expect(result).toMatchObject({ cfdi_document_id: 900, uuid: 'UUID-G', stamped: true });
  const [, docParams] = onTx(/INSERT INTO cfdi_documents/)[0];
  expect(docParams).toEqual(expect.arrayContaining([
    'XAXX010101000', 'PUBLICO EN GENERAL', '26015', '04', '10', 2026, 300, 48, 348,
  ]));
  expect(docParams).toContain('01'); // forma de pago of the cash payments, not 99/03
  const conceptos = onTx(/INSERT INTO cfdi_conceptos/);
  expect(conceptos).toHaveLength(2);
  expect(conceptos[0][1]).toEqual(expect.arrayContaining(['01010101', 'INV-11', 'ACT', 100]));
  expect(onTx(/INSERT INTO cfdi_concepto_impuestos/).map(([, p]) => p[2])).toEqual(['0.160000', '0.160000']);
  expect(onTx(/UPDATE factura_publica_invoices\s+SET cfdi_document_id/)).toHaveLength(1);
  expect(conn.commit).toHaveBeenCalledTimes(1);
});

test.each([
  ['an unpaid invoice', { invoices: [{ ...INVOICES[0], status: 'issued' }] }, 'FACTURA_PUBLICA_UNPAID'],
  ['an invoice with its own CFDI', { ownCfdi: [{ invoice_id: 11 }] }, 'FACTURA_PUBLICA_INVOICE_HAS_CFDI'],
  ['no invoices', { invoices: [] }, 'FACTURA_PUBLICA_EMPTY'],
  ['a bimestral period with a single month', { factura: { ...FACTURA, periodicidad: '05', meses: '03' } }, 'FACTURA_PUBLICA_PERIOD_INVALID'],
  ['an already stamped record', { factura: { ...FACTURA, status: 'stamped', cfdi_document_id: 4 } }, 'FACTURA_PUBLICA_NOT_DRAFT'],
])('refuses %s and files nothing', async (_label, opts, code) => {
  wire(opts);
  await expect(facturaPublicaService.stampGlobal(3, 1)).rejects.toMatchObject({ code });
  expect(onTx(/INSERT INTO cfdi_documents/)).toHaveLength(0);
  expect(cfdiService.stamp).not.toHaveBeenCalled();
});

test.each([
  ['04', '10', 2026, null],
  ['05', '13', 2026, null],
  ['05', '03', 2026, /13-18/],
  ['01', '14', 2026, /01-12/],
  ['06', '01', 2026, /Periodicidad/],
])('period %s/%s/%s', (p, m, y, problem) => {
  const result = globalPeriodProblem(p, m, y);
  if (problem) expect(result).toMatch(problem); else expect(result).toBeNull();
});

describe('InformacionGlobal in the XML', () => {
  const emisor = { rfc: 'EKU9003173C9', razon_social: 'ISP', regimen_fiscal: '601', codigo_postal_fiscal: '06600' };
  const base = { tipo_comprobante: 'I', serie: 'A', folio: 1, moneda: 'MXN', subtotal: 0, total: 0, receptor_rfc: 'XAXX010101000', receptor_regimen: '616', receptor_cp: '06600', uso_cfdi: 'S01', created_at: '2026-11-01T10:00:00Z' };

  test('a factura global reports its own period', () => {
    const xml = cfdiService.buildCfdi40Xml({ ...base, receptor_nombre: 'PUBLICO EN GENERAL', global_periodicidad: '04', global_meses: '10', global_anio: 2026 }, emisor, [], []);
    expect(xml).toContain('<cfdi:InformacionGlobal Periodicidad="04" Meses="10" Año="2026" />');
  });

  test('an XAXX receptor with a person\'s name is not a global', () => {
    const xml = cfdiService.buildCfdi40Xml({ ...base, receptor_nombre: 'JUAN PEREZ' }, emisor, [], []);
    expect(xml).not.toContain('InformacionGlobal');
  });
});
