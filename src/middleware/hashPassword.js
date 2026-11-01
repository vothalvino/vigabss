// =============================================================================
// VigaBSS 5.0 — Password-hashing middleware
// =============================================================================
// The user create/update validation schemas accept a plaintext `password`, but
// the `users` table stores `password_hash` (the only password column exposed by
// User.fillable). The generic crudController inserts the validated body verbatim
// with no hashing, so without this the plaintext field is dropped and
// password_hash is left unset → "Field 'password_hash' doesn't have a default
// value" → a 500 on every user create. Run this AFTER validation to convert the
// plaintext `password` into a bcrypt `password_hash` (matching authService's cost)
// once it passes the organization's password policy.
// =============================================================================

const bcrypt = require('bcryptjs');
const { assertPasswordAllowed } = require('../services/passwordPolicyService');

const SALT_ROUNDS = 12;

async function hashPasswordField(req, _res, next) {
  try {
    if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
      // The organization's password policy (SEC-17) applies to passwords an
      // administrator sets, too.
      await assertPasswordAllowed(req.body.password, req.orgId);
      req.body.password_hash = await bcrypt.hash(req.body.password, SALT_ROUNDS);
    }
    if (req.body) delete req.body.password;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { hashPasswordField, SALT_ROUNDS };
