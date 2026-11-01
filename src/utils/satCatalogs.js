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

module.exports = { FORMA_PAGO_BY_METHOD, usoCfdiAllowed, defaultUsoCfdi };
