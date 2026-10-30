// =============================================================================
// VigaBSS 5.0 — Payment Gateway Validation Schemas
// =============================================================================

const createPaymentGateway = {
  name: { type: 'string', required: true, max: 100 },
  provider: { type: 'string', required: true, enum: ['stripe', 'conekta', 'openpay', 'mercadopago', 'paypal', 'manual', 'other'] },
  environment: { type: 'string', enum: ['sandbox', 'production'] },
  public_key: { type: 'string', max: 500 },
  // Write-only plaintext; stored encrypted in secret_key_encrypted /
  // webhook_secret_encrypted by src/utils/sealSecrets.js and never returned.
  secret_key: { type: 'string', max: 1000 },
  webhook_secret: { type: 'string', max: 1000 },
  is_default: { type: 'boolean' },
  config_json: { type: 'string', max: 5000 },
  status: { type: 'string', enum: ['active', 'inactive'] },
};

const updatePaymentGateway = {
  name: { type: 'string', max: 100 },
  provider: { type: 'string', enum: ['stripe', 'conekta', 'openpay', 'mercadopago', 'paypal', 'manual', 'other'] },
  environment: { type: 'string', enum: ['sandbox', 'production'] },
  public_key: { type: 'string', max: 500 },
  // Blank or absent keeps the stored secret.
  secret_key: { type: 'string', max: 1000 },
  webhook_secret: { type: 'string', max: 1000 },
  is_default: { type: 'boolean' },
  config_json: { type: 'string', max: 5000 },
  status: { type: 'string', enum: ['active', 'inactive'] },
};

module.exports = { createPaymentGateway, updatePaymentGateway };
