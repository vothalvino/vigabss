// =============================================================================
// VigaBSS 5.0 — Link Planning Validation Schemas
// =============================================================================
// Saving a calculation had no validation: one without a name or a frequency
// failed the INSERT on a NOT NULL column with a 500.
// =============================================================================

const createLinkPlanningCalc = {
  name: { type: 'string', required: true, min: 1, max: 100 },
  site_a_id: { type: 'number', min: 1 },
  site_b_id: { type: 'number', min: 1 },
  lat_a: { type: 'number', min: -90, max: 90 },
  lon_a: { type: 'number', min: -180, max: 180 },
  lat_b: { type: 'number', min: -90, max: 90 },
  lon_b: { type: 'number', min: -180, max: 180 },
  frequency_mhz: { type: 'number', required: true, min: 1 },
  tx_power_dbm: { type: 'number' },
  antenna_gain_a_dbi: { type: 'number' },
  antenna_gain_b_dbi: { type: 'number' },
  cable_loss_db: { type: 'number', min: 0 },
  notes: { type: 'string', max: 65535 },
};

const updateLinkPlanningCalc = {
  ...createLinkPlanningCalc,
  name: { type: 'string', min: 1, max: 100 },
  frequency_mhz: { type: 'number', min: 1 },
};

module.exports = { createLinkPlanningCalc, updateLinkPlanningCalc };
