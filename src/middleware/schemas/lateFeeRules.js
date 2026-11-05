// =============================================================================
// VigaBSS 5.0 — Late Fee Rule Validation Schemas
// =============================================================================
// The routes had none: a rule without a name, or with a fee type the column's
// ENUM does not have, failed in MySQL with a 500.
// =============================================================================

const createLateFeeRule = {
  name: { type: 'string', required: true, min: 1, max: 255 },
  fee_type: { type: 'string', enum: ['flat', 'percent'] },
  fee_amount: { type: 'number', min: 0 },
  grace_period_days: { type: 'number', min: 0 },
  max_applications: { type: 'number', min: 1 },
  is_active: { type: 'boolean' },
};

const updateLateFeeRule = {
  ...createLateFeeRule,
  name: { type: 'string', min: 1, max: 255 },
};

module.exports = { createLateFeeRule, updateLateFeeRule };
