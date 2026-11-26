// =============================================================================
// VigaBSS 5.0 — Money tie-out validation schemas
// =============================================================================

const PURPOSES = ['client_invoices', 'general_public', 'any'];

const createBankAccountSchema = {
  name: { type: 'string', required: true, min: 1, max: 100 },
  bank_name: { type: 'string', max: 100 },
  // A hint to tell accounts apart (last digits), never the account number.
  account_hint: { type: 'string', max: 20 },
  purpose: { type: 'string', enum: PURPOSES },
};

const updateBankAccountSchema = {
  name: { type: 'string', min: 1, max: 100 },
  bank_name: { type: 'string', max: 100 },
  account_hint: { type: 'string', max: 20 },
  purpose: { type: 'string', enum: PURPOSES },
  status: { type: 'string', enum: ['active', 'inactive'] },
};

// A count states what is in the safe (0 is a valid count); the other kinds
// move cash and need an amount above 0, which the service checks.
const safeMovementSchema = {
  kind: { type: 'string', required: true, enum: ['count', 'deposit', 'other_in', 'other_out'] },
  amount: { type: 'number', required: true, min: 0, max: 9999999999.99 },
  bank_account_id: { type: 'number', min: 1 },
  moved_at: { type: 'string', max: 40 },
  reference: { type: 'string', max: 100 },
  note: { type: 'string', max: 500 },
};

module.exports = { createBankAccountSchema, updateBankAccountSchema, safeMovementSchema };
