// =============================================================================
// VigaBSS 5.0 — PAC Provider Validation Schemas
// =============================================================================

const createPacProvider = {
  provider_name: { type: 'string', required: true, enum: ['finkok', 'sw_sapien', 'digicel', 'comercio_digital', 'facturapi', 'other', 'simulator'] },
  // label + api_url are NOT NULL columns with no default — an absent value
  // used to surface as a raw 500 from MySQL instead of a 422.
  label: { type: 'string', required: true, max: 100 },
  api_url: { type: 'string', required: true, max: 500 },
  environment: { type: 'string', enum: ['sandbox', 'production'] },
  seal_mode: { type: 'string', enum: ['pac', 'local'] },
  priority: { type: 'number', min: 0, max: 1000 },
  // Write-only plaintext credentials; stored encrypted in the matching
  // *_encrypted columns by src/utils/sealSecrets.js and never returned.
  username: { type: 'string', max: 200 },
  password: { type: 'string', max: 200 },
  // SW "infinite token" (portal ADT) — alternative to user+password.
  token: { type: 'string', max: 1000 },
  status: { type: 'string', enum: ['active', 'inactive'] },
};

const updatePacProvider = {
  provider_name: { type: 'string', enum: ['finkok', 'sw_sapien', 'digicel', 'comercio_digital', 'facturapi', 'other', 'simulator'] },
  label: { type: 'string', max: 100 },
  environment: { type: 'string', enum: ['sandbox', 'production'] },
  seal_mode: { type: 'string', enum: ['pac', 'local'] },
  priority: { type: 'number', min: 0, max: 1000 },
  // Blank or absent keeps the stored credential.
  username: { type: 'string', max: 200 },
  password: { type: 'string', max: 200 },
  token: { type: 'string', max: 1000 },
  api_url: { type: 'string', max: 500 },
  status: { type: 'string', enum: ['active', 'inactive'] },
};

module.exports = { createPacProvider, updatePacProvider };
