// =============================================================================
// VigaBSS 5.0 — Factura Pública Validation Schemas
// =============================================================================

// Status, totals and the CFDI link are set by POST /:id/stamp (BIL-24). There
// is no notes column: notes were accepted here and then dropped (FE2-13).
const createFacturaPublica = {
  periodicidad: { type: 'string', required: true, enum: ['01', '02', '03', '04', '05'] },
  meses: { type: 'string', required: true, pattern: /^(0[1-9]|1[0-8])$/ },
  anio: { type: 'number', required: true, min: 2022, max: 2099 },
};

const updateFacturaPublica = {
  periodicidad: { type: 'string', enum: ['01', '02', '03', '04', '05'] },
  meses: { type: 'string', pattern: /^(0[1-9]|1[0-8])$/ },
  anio: { type: 'number', min: 2022, max: 2099 },
};

const addFacturaPublicaItem = {
  invoice_id: { type: 'number', required: true, min: 1 },
};

// Link every eligible invoice of the period; with a currency, only that one's.
const addEligibleFacturaPublicaItems = {
  currency: { type: 'string', pattern: /^[A-Z]{3}$/ },
};

module.exports = { createFacturaPublica, updateFacturaPublica, addFacturaPublicaItem, addEligibleFacturaPublicaItems };
