// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Validation Schemas
// =============================================================================

const openSessionSchema = {
  notes: { type: 'string' },
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

module.exports = { openSessionSchema, closeSessionSchema, approveSessionSchema, disputeSessionSchema };
