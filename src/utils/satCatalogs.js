// =============================================================================
// VigaBSS 5.0 — SAT catalog rules used when building a CFDI
// =============================================================================
// c_FormaPago for a payment method, and which c_UsoCFDI values a receptor's
// c_RegimenFiscal admits (catalog column "Régimen Fiscal Receptor", CFDI 4.0).
// The PAC rejects a mismatched pair (CFDI40161), so it is checked before the
// document is built (BIL-26).
// =============================================================================

// payments.payment_method → SAT c_FormaPago when sat_forma_pago isn't set.
// Covers every value of the payment_method ENUM (schema.sql) — an unmapped
// method would silently stamp the wrong forma.
const FORMA_PAGO_BY_METHOD = {
  cash: '01', check: '02', transfer: '03', card: '04', online: '03',
  credit_card: '04', debit_card: '28', bank_transfer: '03',
  oxxo_pay: '01', spei: '03', codi: '06', convenience_store: '01',
  digital_wallet: '05', other: '03',
};

// Regímenes with business activity: gastos (G01-G03) and inversiones (I01-I08).
const BUSINESS_REGIMES = new Set(['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626']);
// Regímenes that may claim personal deductions (D01-D10).
const DEDUCTION_REGIMES = new Set(['605', '606', '607', '608', '611', '612', '614', '615', '625']);

function regimesFor(usoCfdi) {
  if (/^[GI]\d\d$/.test(usoCfdi)) return BUSINESS_REGIMES;
  if (/^D\d\d$/.test(usoCfdi)) return DEDUCTION_REGIMES;
  if (usoCfdi === 'CN01') return new Set(['605']);
  return null; // S01, CP01: any régimen
}

/** True when SAT admits this UsoCFDI for this receptor régimen. */
function usoCfdiAllowed(usoCfdi, regimen) {
  const allowed = regimesFor(String(usoCfdi || ''));
  return !allowed || allowed.has(String(regimen || ''));
}

/** G03 where the régimen admits it, otherwise S01 (sin efectos fiscales). */
function defaultUsoCfdi(regimen) {
  return usoCfdiAllowed('G03', regimen) ? 'G03' : 'S01';
}

// CFDI 4.0 XSD text patterns are [^|]{1,n}, and XML 1.0 forbids most C0
// control characters; either makes the PAC reject the document (CFD-12).
// eslint-disable-next-line no-control-regex
const CFDI_FORBIDDEN_CHARS = /[|\u0000-\u001F\u007F]/;
const NOMBRE_MAX = 254;
const DESCRIPCION_MAX = 1000;

/** Text safe for a CFDI attribute: '|' becomes '/', control characters go. */
function cfdiText(value, max = DESCRIPCION_MAX) {
  // eslint-disable-next-line no-control-regex
  const clean = String(value ?? '').replace(/\|/g, '/').replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return clean.slice(0, max);
}

/** Why a fiscal Nombre (razón social) cannot be filed, or null when it can. */
function nombreProblem(value) {
  const text = String(value ?? '');
  if (text.length > NOMBRE_MAX) return `is ${text.length} characters; SAT allows at most ${NOMBRE_MAX}`;
  if (CFDI_FORBIDDEN_CHARS.test(text)) return "contains '|' or a control character, which SAT does not accept";
  return null;
}

// c_TasaOCuota for IVA traslado (Tasa): 16%, the 8% border-zone rate, 0%.
const IVA_RATES = [0.16, 0.08, 0];

/**
 * The catalog IVA rate an invoice rate stands for, or null. A rate derived
 * back from tax_amount / subtotal drifts by the cent rounding of the tax
 * (1.60 / 10.03 = 0.1595, 1.61 / 10 = 0.161); within 0.15 of a point it is
 * that catalog rate, beyond it (12%, 17%) it is not a rate SAT has.
 */
const IVA_RATE_TOLERANCE = 0.0015;
function catalogIvaRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return null;
  const match = IVA_RATES.find(c => Math.abs(c - r) <= IVA_RATE_TOLERANCE);
  return match === undefined ? null : match;
}

// InformacionGlobal (factura global): c_Periodicidad 01-04 (diario, semanal,
// quincenal, mensual) report one month (Meses 01-12); 05 (bimestral) reports
// a two-month block (Meses 13-18 = Ene-Feb … Nov-Dic). BIL-24.
const PUBLICO_EN_GENERAL_RFC = 'XAXX010101000';
const PUBLICO_EN_GENERAL_NOMBRE = 'PUBLICO EN GENERAL';

/** Why a global period cannot be filed, or null when it can. */
function globalPeriodProblem(periodicidad, meses, anio) {
  const p = String(periodicidad ?? '');
  const m = Number(meses);
  if (!['01', '02', '03', '04', '05'].includes(p)) return 'Periodicidad must be 01, 02, 03, 04 or 05';
  if (!/^\d{2}$/.test(String(meses ?? ''))) return 'Meses must be a two-digit code';
  if (p === '05' ? (m < 13 || m > 18) : (m < 1 || m > 12)) {
    return p === '05'
      ? 'a bimestral (05) global reports Meses 13-18'
      : `Periodicidad ${p} reports a single month, Meses 01-12`;
  }
  const y = Number(anio);
  if (!Number.isInteger(y) || y < 2022 || y > 2099) return 'Año must be a year from 2022';
  return null;
}

/** InformacionGlobal applies only to the PUBLICO EN GENERAL receptor. */
function isPublicoEnGeneral(rfc, nombre) {
  return rfc === PUBLICO_EN_GENERAL_RFC
    && String(nombre ?? '').trim().toUpperCase() === PUBLICO_EN_GENERAL_NOMBRE;
}

module.exports = {
  FORMA_PAGO_BY_METHOD, usoCfdiAllowed, defaultUsoCfdi,
  PUBLICO_EN_GENERAL_RFC, PUBLICO_EN_GENERAL_NOMBRE, globalPeriodProblem, isPublicoEnGeneral,
  CFDI_FORBIDDEN_CHARS, NOMBRE_MAX, cfdiText, nombreProblem, catalogIvaRate,
};
