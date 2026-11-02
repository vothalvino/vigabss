// =============================================================================
// VigaBSS 5.0 — Factura Pública Validation Schemas
// =============================================================================

// Status, totals and the CFDI link are set by POST /:id/stamp (BIL-24).
const createFacturaPublica = {
  periodicidad: { type: 'string', required: true, enum: ['01', '02', '03', '04', '05'] },
  meses: { type: 'string', required: true, pattern: /^(0[1-9]|1[0-8])$/ },
  anio: { type: 'number', required: true, min: 2022, max: 2099 },
  notes: { type: 'string', max: 5000 },
};

const updateFacturaPublica = {
  periodicidad: { type: 'string', enum: ['01', '02', '03', '04', '05'] },
  meses: { type: 'string', pattern: /^(0[1-9]|1[0-8])$/ },
  anio: { type: 'number', min: 2022, max: 2099 },
  notes: { type: 'string', max: 5000 },
};

const addFacturaPublicaItem = {
  invoice_id: { type: 'number', required: true, min: 1 },
};

module.exports = { createFacturaPublica, updateFacturaPublica, addFacturaPublicaItem };
