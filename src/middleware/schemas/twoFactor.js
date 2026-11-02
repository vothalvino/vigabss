// =============================================================================
// VigaBSS 5.0 — Two-Factor Authentication Validation Schemas
// =============================================================================

const verifyCode = {
  code: { type: 'string', required: true, min: 4, max: 24 },
};

// Body is optional; one of these is required only when 2FA is already enabled.
const setup = {
  code: { type: 'string', required: false, min: 4, max: 24 },
  password: { type: 'string', required: false, max: 1024 },
};

module.exports = { verifyCode, setup };
