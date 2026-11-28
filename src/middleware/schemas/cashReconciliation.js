// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Validation Schemas
// =============================================================================

const openSessionSchema = {
  notes: { type: 'string' },
  // The cash counted in the drawer when the shift starts.
  opening_total: { type: 'number', required: true, min: 0, max: 9999999999.99 },
};

const closeSessionSchema = {
  counted_total: { type: 'number', required: true, min: 0 },
};

// Approving a matched count needs no note; the service asks for one when the
// count differed, and always for a dispute.
const approveSessionSchema = {
  note: { type: 'string', max: 1000 },
};

const disputeSessionSchema = {
  note: { type: 'string', required: true, min: 3, max: 1000 },
};

// Cash a supervisor takes out of an open cashier.
const pickupSchema = {
  amount: { type: 'number', required: true, min: 0.01, max: 9999999999.99 },
  note: { type: 'string', max: 500 },
};

// What a supervisor sets: when cash should be handed in, and whether a
// cashier over that amount is stopped or only reminded.
const pickupRulesSchema = {
  pickup_threshold: { type: 'number', min: 0, max: 9999999999.99 },
  pickup_strict: { type: 'boolean' },
};

// One person's cash limit, set by a supervisor.
const userLimitSchema = {
  pickup_threshold: { type: 'number', required: true, min: 0, max: 9999999999.99 },
  pickup_strict: { type: 'boolean' },
};

module.exports = {
  openSessionSchema, closeSessionSchema, approveSessionSchema, disputeSessionSchema,
  pickupSchema, pickupRulesSchema, userLimitSchema,
};
