// =============================================================================
// VigaBSS 5.0 — Auth Validation Schemas
// =============================================================================

const register = {
  firstName: { type: 'string', required: true, min: 1, max: 100 },
  lastName: { type: 'string', required: true, min: 1, max: 100 },
  email: { type: 'email', required: true },
  password: { type: 'string', required: true, min: 8 },
};

const login = {
  email: { type: 'email', required: true },
  password: { type: 'string', required: true },
};

// Second step of a 2FA login: the challenge from POST /auth/login (or an SSO
// callback) plus a 6-digit TOTP or a XXXX-XXXX backup code.
const loginMfa = {
  mfa_token: { type: 'string', required: true, max: 2048 },
  code: { type: 'string', required: true, min: 4, max: 10 },
};

const requestPasswordReset = {
  email: { type: 'email', required: true },
};

const resetPassword = {
  token: { type: 'string', required: true },
  password: { type: 'string', required: true, min: 8 },
};

const changePassword = {
  currentPassword: { type: 'string', required: true },
  newPassword: { type: 'string', required: true, min: 8 },
};

const verifyEmail = {
  token: { type: 'string', required: true },
};

// refreshToken is optional in body — browser clients send it via httpOnly cookie instead
const refreshToken = {
  refreshToken: { type: 'string', required: false },
};

// refreshToken is optional in body — browser clients send it via httpOnly cookie instead
const switchOrganization = {
  organizationId: { type: 'number', required: true, min: 1 },
  refreshToken: { type: 'string', required: false },
};

module.exports = { register, login, loginMfa, requestPasswordReset, resetPassword, changePassword, verifyEmail, refreshToken, switchOrganization };
