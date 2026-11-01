// =============================================================================
// CFD-05 — Fecha is local time at LugarExpedicion, not always Mexico City
// =============================================================================
// Anexo 20 defines Fecha as local time where the CFDI is issued, and PACs read
// it in the c_CodigoPostal zone of LugarExpedicion, refusing future values.
// Writing Mexico City time put issuers in Baja California (UTC-8/-7) and in
// Baja California Sur, Sonora, Sinaloa and Nayarit (UTC-7) 1-2h ahead, so
// every first stamp of their invoices, egresos and REPs failed.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const cfdiService = require('../src/services/cfdiService');
const { timeZoneForPostalCode } = require('../src/utils/mxTimeZone');

describe('timeZoneForPostalCode', () => {
  test.each([
    ['22000', 'America/Tijuana'], // Tijuana, BC
    ['21100', 'America/Tijuana'], // Mexicali, BC
    ['23000', 'America/Mazatlan'], // La Paz, BCS
    ['83000', 'America/Hermosillo'], // Hermosillo, Sonora
    ['80000', 'America/Mazatlan'], // Culiacán, Sinaloa
    ['63000', 'America/Mazatlan'], // Tepic, Nayarit
    ['63732', 'America/Bahia_Banderas'], // Bahía de Banderas, Nayarit
    ['77500', 'America/Cancun'], // Cancún, Quintana Roo
    ['32000', 'America/Ciudad_Juarez'], // Ciudad Juárez, Chihuahua
    ['31000', 'America/Mexico_City'], // Chihuahua city
    ['06600', 'America/Mexico_City'], // CDMX
    ['64000', 'America/Mexico_City'], // Monterrey
    ['', 'America/Mexico_City'],
    [null, 'America/Mexico_City'],
    ['ABCDE', 'America/Mexico_City'],
  ])('%s → %s', (cp, zone) => {
    expect(timeZoneForPostalCode(cp)).toBe(zone);
  });
});

describe('cfdiExpeditionTime in the issuer\'s zone', () => {
  const SUMMER = new Date('2026-07-20T18:00:00Z');
  const WINTER = new Date('2026-01-20T18:00:00Z');

  test.each([
    ['22000', SUMMER, '2026-07-20T11:00:00'], // Tijuana, PDT (UTC-7)
    ['22000', WINTER, '2026-01-20T10:00:00'], // Tijuana, PST (UTC-8)
    ['83000', SUMMER, '2026-07-20T11:00:00'], // Sonora, no DST (UTC-7)
    ['23000', WINTER, '2026-01-20T11:00:00'], // BCS (UTC-7)
    ['06600', SUMMER, '2026-07-20T12:00:00'], // CDMX (UTC-6)
    ['77500', SUMMER, '2026-07-20T13:00:00'], // Cancún (UTC-5)
  ])('LugarExpedicion %s', (cp, when, expected) => {
    expect(cfdiService.cfdiExpeditionTime(when, timeZoneForPostalCode(cp))).toBe(expected);
  });

  test('defaults to Mexico City', () => {
    expect(cfdiService.cfdiExpeditionTime(SUMMER)).toBe('2026-07-20T12:00:00');
  });
});

describe('the XML builders write Fecha in that zone', () => {
  beforeAll(() => { jest.useFakeTimers({ now: new Date('2026-07-20T18:00:00Z') }); });
  afterAll(() => { jest.useRealTimers(); });

  const doc = {
    serie: 'A', folio: '001', forma_pago: '01', metodo_pago: 'PUE', tipo_comprobante: 'I',
    exportacion: '01', moneda: 'MXN', subtotal: '500.00', total: '580.00',
    receptor_rfc: 'XBXX020202000', receptor_nombre: 'Client', receptor_cp: '22000', receptor_regimen: '616', uso_cfdi: 'G03',
  };

  test('an invoice issued in Tijuana', () => {
    const xml = cfdiService.buildCfdi40Xml(doc, { rfc: 'XAXX010101000', razon_social: 'ISP BC', regimen_fiscal: '601', codigo_postal_fiscal: '22000' }, [], []);
    expect(xml).toContain('Fecha="2026-07-20T11:00:00"');
    expect(xml).toContain('LugarExpedicion="22000"');
  });

  test('an invoice issued in CDMX is unchanged', () => {
    const xml = cfdiService.buildCfdi40Xml(doc, { rfc: 'XAXX010101000', razon_social: 'ISP', regimen_fiscal: '601', codigo_postal_fiscal: '06600' }, [], []);
    expect(xml).toContain('Fecha="2026-07-20T12:00:00"');
  });

  test('a REP built from an instant converts it to the LugarExpedicion zone', () => {
    const xml = cfdiService.buildPaymentComplementXml(
      { serie: 'P', folio: 1, fecha_emision: new Date('2026-07-20T18:00:00Z'), lugar_expedicion: '83000',
        emisor_rfc: 'XAXX010101000', emisor_nombre: 'ISP', emisor_regimen_fiscal: '601',
        receptor_rfc: 'XBXX020202000', receptor_nombre: 'C', receptor_domicilio_fiscal: '83000', receptor_regimen_fiscal: '616' },
      { payment_date: '2026-07-20', forma_pago: '03', moneda: 'MXN', amount: 100 },
      [{ related_cfdi_uuid: 'U', imp_saldo_ant: 100, imp_pagado: 100, imp_saldo_insoluto: 0 }],
    );
    expect(xml).toContain('Fecha="2026-07-20T11:00:00"');
  });
});
