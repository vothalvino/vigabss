// =============================================================================
// CFD-03 — Concepto amounts stay within the Anexo 20 limits
// =============================================================================
// The last-line IVA plug could drift outside a line's traslado limits, the
// DECIMAL(x,4) columns were written raw ("824.1900" narrows each limit), and
// a quantity rounded to 2 decimals no longer matched its Importe for
// fractional and per-GB overage lines.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const db = require('../src/config/database');
const {
  allocateLineTaxes, trasladoImporteBounds, conceptoImporteBounds, anexo20Violations,
  formatQuantity, formatUnitValue,
} = require('../src/utils/cfdiAmounts');
const { resolveLineItemPricing } = require('../src/utils/lineItemPricing');
const billingService = require('../src/services/billingService');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('per-line IVA split', () => {
  // The audit's case: 816.35 + 3 × 133.87 + 824.19 at 16 %, tax 326.74.
  const bases = [816.35, 133.87, 133.87, 133.87, 824.19];

  test('the old last-line plug (131.86) is outside its limits once Base is written with 4 decimals', () => {
    const [lo] = trasladoImporteBounds('824.1900', 0.16);
    expect(131.86).toBeLessThan(lo);
  });

  test('the split sums to the invoice tax and keeps every line within its limits', () => {
    const taxes = allocateLineTaxes(bases, 0.16, 326.74);
    expect(Math.round(taxes.reduce((a, b) => a + b, 0) * 100) / 100).toBe(326.74);
    bases.forEach((base, i) => {
      const [lo, hi] = trasladoImporteBounds(base.toFixed(2), 0.16);
      expect(taxes[i]).toBeGreaterThanOrEqual(lo);
      expect(taxes[i]).toBeLessThanOrEqual(hi);
    });
  });

  test('round(subtotal × rate) can always be split (randomised lines)', () => {
    let seed = 7;
    const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let run = 0; run < 500; run++) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 8) }, () => Math.round(next() * 200000) / 100);
      const subtotal = lines.reduce((a, b) => a + b, 0);
      const tax = Math.round(subtotal * 0.16 * 100) / 100;
      const split = allocateLineTaxes(lines, 0.16, tax);
      expect(split).not.toBeNull();
      lines.forEach((base, i) => {
        const [lo, hi] = trasladoImporteBounds(base.toFixed(2), 0.16);
        expect(split[i]).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(split[i]).toBeLessThanOrEqual(hi + 1e-9);
      });
    }
  });

  test('a tax that cannot be split within the limits is reported', () => {
    expect(allocateLineTaxes([100], 0.16, 17)).toBeNull();
  });
});

describe('values are written at their own precision', () => {
  test.each([
    ['1.0000', '1'], ['1.3300', '1.33'], ['12.3450', '12.345'],
  ])('Cantidad %s → %s', (stored, written) => expect(formatQuantity(stored)).toBe(written));

  test.each([
    ['300.0000', '300.00'], ['0.3333', '0.3333'],
  ])('ValorUnitario %s → %s', (stored, written) => expect(formatUnitValue(stored)).toBe(written));

  test('the generated XML carries 2-decimal amounts, not the column scale', async () => {
    const cfdiService = require('../src/services/cfdiService');
    jest.spyOn(cfdiService, 'getEmisorProfile');
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id/.test(sql)) {
        return [[{ id: 1, organization_id: 1, sat_status: 'draft', receptor_rfc: 'XAXX010101000', receptor_nombre: 'PUBLICO EN GENERAL', receptor_regimen: '616', receptor_cp: '01000', subtotal: '824.1900', total: '956.0600', moneda: 'MXN', tipo_comprobante: 'I', uso_cfdi: 'S01' }]];
      }
      if (/FROM organization_mx_profiles/.test(sql)) return [[{ rfc: 'EKU9003173C9', razon_social: 'E', regimen_fiscal: '601', codigo_postal_fiscal: '42501' }]];
      if (/FROM cfdi_conceptos/.test(sql)) return [[{ id: 5, cantidad: '1.0000', valor_unitario: '824.1900', importe: '824.1900', clave_prod_serv: '81112100', clave_unidad: 'E48', descripcion: 'Internet' }]];
      if (/FROM cfdi_concepto_impuestos/.test(sql)) return [[{ cfdi_concepto_id: 5, tax_type: 'traslado', impuesto: '002', tipo_factor: 'Tasa', tasa_o_cuota: '0.160000', base: '824.1900', importe: '131.8700' }]];
      return [[]];
    });

    const { xml } = await cfdiService.generateXml(1);

    expect(xml).toContain('Cantidad="1" ');
    expect(xml).toContain('ValorUnitario="824.19" Importe="824.19"');
    expect(xml).toContain('Base="824.19" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="131.87"');
    expect(xml).toContain('SubTotal="824.19"');
    expect(xml).not.toMatch(/="\d+\.\d{4}"/);
  });

  test('amounts outside the limits are refused before the PAC sees them', async () => {
    const cfdiService = require('../src/services/cfdiService');
    db.query.mockImplementation(async (sql) => {
      if (/SELECT \* FROM cfdi_documents WHERE id/.test(sql)) {
        return [[{ id: 1, organization_id: 1, sat_status: 'draft', receptor_rfc: 'XAXX010101000', receptor_nombre: 'P', receptor_regimen: '616', receptor_cp: '01000' }]];
      }
      if (/FROM organization_mx_profiles/.test(sql)) return [[{ rfc: 'EKU9003173C9', razon_social: 'E', regimen_fiscal: '601', codigo_postal_fiscal: '42501' }]];
      if (/FROM cfdi_conceptos/.test(sql)) return [[{ id: 5, cantidad: '1.33', valor_unitario: '300', importe: '410.00' }]];
      return [[]];
    });

    await expect(cfdiService.generateXml(1)).rejects.toMatchObject({ statusCode: 422, code: 'CFDI_ANEXO20_LIMITS' });
    expect(db.query.mock.calls.some(([sql]) => /SET xml_content/.test(sql))).toBe(false);
  });

  test('anexo20Violations names the line and the allowed range', () => {
    const problems = anexo20Violations(
      // (an integer Cantidad gets ±0.5 under Anexo 20, so use 1.5)
      [{ id: 1, cantidad: '1.5', valor_unitario: '10', importe: '25' }],
      [],
    );
    expect(problems).toEqual([expect.stringMatching(/^Line 1: Importe 25\.00 is not Cantidad 1\.5 × ValorUnitario 10\.00 \(allowed 14\.49–15\.51\)/)]);
  });
});

describe('quantity and price are rounded before the amount', () => {
  test('a 1.333 quantity bills the stored 1.33 × price', () => {
    expect(resolveLineItemPricing({ quantity: 1.333, unit_price: 300 })).toEqual({ qty: 1.33, unitPrice: 300, amount: 399 });
    const [lo, hi] = conceptoImporteBounds(formatQuantity(1.33), formatUnitValue(300));
    expect(399).toBeGreaterThanOrEqual(lo);
    expect(399).toBeLessThanOrEqual(hi);
  });

  test('a per-GB overage line bills the stored GB × stored price', async () => {
    db.query.mockResolvedValueOnce([[{
      data_cap_gb: '100', overage_mode: 'per_gb', overage_price_per_gb: '0.125',
      bytes_used: String(112.345 * 1073741824), // 12.345 GB over the cap
      observed_rows: 30, incomplete_rows: 0, unverifiable_session_rows: 0,
    }]]);
    const result = await billingService.calculateOverageCharges(1, '2026-10-01', '2026-10-31');
    // Stored as DECIMAL(10,2): 12.35 GB × 0.13 — and the amount is exactly that.
    expect(result).toEqual({ overage_gb: 12.35, price_per_gb: 0.13, amount: 1.61 });
  });
});
