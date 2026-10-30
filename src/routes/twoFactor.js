// =============================================================================
// VigaBSS 5.0 — Two-Factor Authentication Routes
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const twoFactorSchemas = require('../middleware/schemas/twoFactor');
const twoFactorService = require('../services/twoFactorService');
const { ForbiddenError } = require('../utils/errors');

const router = Router();
router.use(authenticate);

// The second factor belongs to the person, not to an integration: an API key
// must never read, replace, validate or disable it.
router.use((req, _res, next) => {
  if (req.user?.apiTokenId) {
    return next(new ForbiddenError('API tokens cannot manage two-factor authentication'));
  }
  next();
});

// GET /api/2fa/status — Check if 2FA is enabled
router.get('/status', async (req, res, next) => {
  try {
    const data = await twoFactorService.getStatus(req.user.id);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/2fa/setup — Generate a TOTP secret (returns QR URI). When 2FA is
// already enabled this replaces (and so disables) it, which requires a current
// code or the account password.
router.post('/setup', validate(twoFactorSchemas.setup), async (req, res, next) => {
  try {
    const data = await twoFactorService.generateSecret(req.user.id, {
      code: req.body?.code,
      password: req.body?.password,
    });
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/2fa/verify — Verify code and enable 2FA
router.post('/verify', validate(twoFactorSchemas.verifyCode), async (req, res, next) => {
  try {
    const data = await twoFactorService.verifyAndEnable(req.user.id, req.body.code);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/2fa/validate — Validate a 2FA code (during login flow)
router.post('/validate', validate(twoFactorSchemas.verifyCode), async (req, res, next) => {
  try {
    const data = await twoFactorService.verifyCode(req.user.id, req.body.code);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/2fa/disable — Disable 2FA
router.post('/disable', validate(twoFactorSchemas.verifyCode), async (req, res, next) => {
  try {
    // Require a valid 2FA code to disable
    await twoFactorService.verifyCode(req.user.id, req.body.code);
    const data = await twoFactorService.disable(req.user.id);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/2fa/backup-codes — Regenerate backup codes
router.post('/backup-codes', validate(twoFactorSchemas.verifyCode), async (req, res, next) => {
  try {
    const data = await twoFactorService.regenerateBackupCodes(req.user.id, req.body.code);
    res.json({ data });
  } catch (err) { next(err); }
});

module.exports = router;
