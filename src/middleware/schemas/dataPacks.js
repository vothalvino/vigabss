'use strict';

// =============================================================================
// VigaBSS 5.0 — Data Pack Validation Schemas (§10.3)
// =============================================================================

const createDataPack = {
  name:          { type: 'string', required: true, min: 1, max: 100 },
  description:   { type: 'string', max: 1000 },
  data_gb:       { type: 'number', required: true, min: 0 },
  price:         { type: 'number', required: true, min: 0 },
  currency:      { type: 'string', max: 3 },
  validity_days: { type: 'number', min: 1, max: 3650 },
  // Stored as data_packs.is_active (FE2-11); there is no 'deprecated' state.
  status:        { type: 'string', enum: ['active', 'inactive'] },
  is_active:     { type: 'boolean' },
};

const updateDataPack = {
  name:          { type: 'string', min: 1, max: 100 },
  description:   { type: 'string', max: 1000 },
  data_gb:       { type: 'number', min: 0 },
  price:         { type: 'number', min: 0 },
  currency:      { type: 'string', max: 3 },
  validity_days: { type: 'number', min: 1, max: 3650 },
  // Stored as data_packs.is_active (FE2-11); there is no 'deprecated' state.
  status:        { type: 'string', enum: ['active', 'inactive'] },
  is_active:     { type: 'boolean' },
};

module.exports = { createDataPack, updateDataPack };
