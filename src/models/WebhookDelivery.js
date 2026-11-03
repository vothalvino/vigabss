// =============================================================================
// VigaBSS 5.0 — WebhookDelivery Model
// =============================================================================

const BaseModel = require('./BaseModel');

class WebhookDelivery extends BaseModel {
  static get tableName() { return 'webhook_deliveries'; }
  static get fillable() { return ['webhook_id', 'event_name', 'payload', 'http_status_code', 'response_body', 'response_time_ms', 'attempt_number', 'status']; }
  static get hasOrgScope() { return false; }
}

module.exports = WebhookDelivery;
