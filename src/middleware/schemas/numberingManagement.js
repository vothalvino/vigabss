// =============================================================================
// VigaBSS 5.0 — Numbering Management Validation Schemas (§16.4, TNB-31)
// =============================================================================

const NUMBER_TYPES = ['geographic', 'non_geographic', 'mobile', 'toll_free', 'premium'];
const NUMBER_STATUSES = ['available', 'assigned', 'ported_in', 'ported_out', 'reserved', 'blocked'];
const PORT_TYPES = ['port_in', 'port_out'];
const PORT_STATUSES = ['requested', 'approved', 'rejected', 'cancelled', 'completed'];
const BLOCK_STATUSES = ['active', 'exhausted', 'returned', 'expired'];

const phoneNumberFields = {
  number_type: { type: 'string', enum: NUMBER_TYPES },
  lada: { type: 'string', max: 10 },
  status: { type: 'string', enum: NUMBER_STATUSES },
  client_id: { type: 'number', min: 1 },
  contract_id: { type: 'number', min: 1 },
  block_id: { type: 'number', min: 1 },
  notes: { type: 'string', max: 5000 },
};

const createPhoneNumber = {
  phone_number: { type: 'string', required: true, min: 1, max: 30 },
  ...phoneNumberFields,
};

const updatePhoneNumber = {
  phone_number: { type: 'string', min: 1, max: 30 },
  ...phoneNumberFields,
};

const createPortability = {
  phone_number: { type: 'string', required: true, min: 1, max: 30 },
  port_type: { type: 'string', required: true, enum: PORT_TYPES },
  donor_carrier: { type: 'string', max: 100 },
  recipient_carrier: { type: 'string', max: 100 },
  ifetel_reference: { type: 'string', max: 100 },
  client_id: { type: 'number', min: 1 },
  notes: { type: 'string', max: 5000 },
};

const updatePortability = {
  status: { type: 'string', enum: PORT_STATUSES },
  notes: { type: 'string', max: 5000 },
};

const createNumberingBlock = {
  lada: { type: 'string', required: true, min: 1, max: 20 },
  block_start: { type: 'string', required: true, min: 1, max: 30 },
  block_end: { type: 'string', required: true, min: 1, max: 30 },
  status: { type: 'string', enum: BLOCK_STATUSES },
  notes: { type: 'string', max: 5000 },
};

const updateNumberingBlock = {
  lada: { type: 'string', min: 1, max: 20 },
  block_start: { type: 'string', min: 1, max: 30 },
  block_end: { type: 'string', min: 1, max: 30 },
  status: { type: 'string', enum: BLOCK_STATUSES },
  notes: { type: 'string', max: 5000 },
};

module.exports = {
  createPhoneNumber,
  updatePhoneNumber,
  createPortability,
  updatePortability,
  createNumberingBlock,
  updateNumberingBlock,
};
