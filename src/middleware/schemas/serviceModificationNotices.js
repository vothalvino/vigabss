// =============================================================================
// VigaBSS 5.0 — Service-modification notice schemas (consumer protection)
// =============================================================================
// Fields the caller may set. organization_id, status and noticed_at are the
// server's (REG-12); status moves only through the send and response actions.

const NOTICE_TYPES = ['price_change', 'plan_change', 'tos_change', 'service_termination', 'interruption', 'upgrade', 'downgrade'];
const CHANNELS = ['email', 'sms', 'postal', 'portal', 'all'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const createServiceModificationNotice = {
  notice_type: { type: 'string', required: true, enum: NOTICE_TYPES },
  description: { type: 'string', required: true, min: 1, max: 5000 },
  effective_date: { type: 'string', required: true, pattern: DATE },
  notice_required_days: { type: 'integer', min: 0, max: 365 },
  channel: { type: 'string', enum: CHANNELS },
  client_id: { type: 'number', min: 1 },
  contract_id: { type: 'number', min: 1 },
  notes: { type: 'string', max: 5000 },
};

const updateServiceModificationNotice = {
  notice_type: { type: 'string', enum: NOTICE_TYPES },
  description: { type: 'string', min: 1, max: 5000 },
  effective_date: { type: 'string', pattern: DATE },
  notice_required_days: { type: 'integer', min: 0, max: 365 },
  channel: { type: 'string', enum: CHANNELS },
  client_id: { type: 'number', min: 1 },
  contract_id: { type: 'number', min: 1 },
  notes: { type: 'string', max: 5000 },
};

module.exports = { createServiceModificationNotice, updateServiceModificationNotice };
