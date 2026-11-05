// =============================================================================
// VigaBSS 5.0 — Universal Service Validation Schemas
// =============================================================================
// The USO obligation and rural coverage writes had no validation: a body
// without a NOT NULL column bound undefined and failed with a 500. A PUT
// replaces the whole row, so it requires what a create does.
// =============================================================================

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const createUsoObligation = {
  obligation_type: { type: 'string', required: true, enum: ['universal_service', 'rural_deployment', 'social_coverage', 'network_expansion'] },
  description: { type: 'string', required: true, min: 1, max: 65535 },
  target_metric: { type: 'string', max: 100 },
  target_value: { type: 'number' },
  period_start: { type: 'string', required: true, pattern: DATE },
  period_end: { type: 'string', required: true, pattern: DATE },
  authority_ref: { type: 'string', max: 100 },
  notes: { type: 'string', max: 65535 },
};

const updateUsoObligation = {
  ...createUsoObligation,
  status: { type: 'string', enum: ['pending', 'in_progress', 'met', 'partially_met', 'missed', 'reported'] },
};

const reportUsoObligation = {
  actual_value: { type: 'number' },
};

const createRuralCoverage = {
  report_period: { type: 'string', required: true, pattern: /^\d{4}-(0[1-9]|1[0-2])$/ },
  locality_name: { type: 'string', required: true, min: 1, max: 255 },
  inegi_code: { type: 'string', max: 10 },
  state: { type: 'string', max: 100 },
  municipality: { type: 'string', max: 100 },
  homes_passed: { type: 'number', min: 0 },
  homes_connected: { type: 'number', min: 0 },
  service_type: { type: 'string', required: true, enum: ['broadband', 'mobile', 'fixed_wireless', 'fiber', 'satellite'] },
  download_speed_mbps: { type: 'number', min: 0 },
  upload_speed_mbps: { type: 'number', min: 0 },
  is_underserved: { type: 'boolean' },
  notes: { type: 'string', max: 65535 },
};

const updateRuralCoverage = createRuralCoverage;

module.exports = {
  createUsoObligation, updateUsoObligation, reportUsoObligation, createRuralCoverage, updateRuralCoverage,
};
