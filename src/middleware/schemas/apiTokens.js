// =============================================================================
// VigaBSS 5.0 — API Token Validation Schemas
// =============================================================================

// Scopes are required: an omitted or null scopes column means unrestricted,
// which made full access the silent default. Full access is an explicit
// ["*:write"]. revoked_at is not updatable: revocation is one-way, through
// POST /api-tokens/:id/revoke (SEC-19).
const createApiToken = {
  name: { type: 'string', required: true, min: 1, max: 255 },
  scopes: { type: 'array', required: true },
  expires_at: { type: 'string' },
};

const updateApiToken = {
  name: { type: 'string', min: 1, max: 255 },
  scopes: { type: 'array' },
  expires_at: { type: 'string' },
};

module.exports = { createApiToken, updateApiToken };
