// =============================================================================
// VigaBSS 5.0 — PAC Provider Routes
// =============================================================================

const { Router } = require('express');
const PacProvider = require('../models/PacProvider');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requireMxLocale } = require('../middleware/orgLocale');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createPacProvider, updatePacProvider } = require('../middleware/schemas/pacProviders');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');
const { sealSecretFields } = require('../utils/sealSecrets');
const db = require('../config/database');
const auditLog = require('../services/auditLog');
const { AppError } = require('../utils/errors');
const { isTestInstall, fiscalEnvironment } = require('../utils/installMode');

const router = Router();

// Never expose encrypted PAC (Proveedor Autorizado de Certificación) account
// credentials in any response body. All four columns hold ciphertext at
// rest — but src/utils/encryption.js's encrypt()/decrypt() are transparent
// no-ops when ENCRYPTION_KEY is unset (dev/test/misconfigured prod), in which
// case they hold PLAINTEXT credentials. The UI only needs to know whether a
// credential is configured, not its value. Mirrors
// src/routes/paymentGateways.js's redact.
function redactPacProvider(row) {
  if (!row || typeof row !== 'object') return row;
  const rest = { ...row };
  const hasUsername = Boolean(rest.username_encrypted);
  const hasPassword = Boolean(rest.password_encrypted);
  const hasApiKey = Boolean(rest.api_key_encrypted);
  const hasToken = Boolean(rest.token_encrypted);
  delete rest.username_encrypted;
  delete rest.password_encrypted;
  delete rest.api_key_encrypted;
  delete rest.token_encrypted;
  return {
    ...rest,
    has_username: hasUsername,
    has_password: hasPassword,
    has_api_key: hasApiKey,
    has_token: hasToken,
  };
}

const ctrl = crudController(PacProvider, { serialize: redactPacProvider });

router.use(authenticate);
router.use(orgScope);
router.use(requireMxLocale);

// api_url is a server-side outbound target — reject SSRF destinations
// (non-https, private/loopback/metadata) before it can be stored and used
// as a PAC endpoint. Only runs when api_url is present in the body.
// The simulator never calls out; its row carries this placeholder, which does
// not resolve and so could never pass the outbound check below.
const SIMULATOR_API_URL = 'https://simulator.invalid';

async function guardApiUrl(req, _res, next) {
  try {
    if (req.body && req.body.provider_name === 'simulator') {
      req.body.api_url = SIMULATOR_API_URL;
      return next();
    }
    if (req.body && req.body.api_url !== undefined && req.body.api_url !== null && req.body.api_url !== '') {
      req.body.api_url = await assertSafeOutboundUrl(req.body.api_url, 'api_url');
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// -----------------------------------------------------------------------------
// The fiscal environment (sandbox | production) PACs stamp and cancel in. It
// follows the install's one live/test switch (src/utils/installMode.js): a
// live install is 'production', a test install 'sandbox'. Nobody chooses it,
// per organization or per PAC. Declared BEFORE '/:id' so 'environment' is not
// captured as an :id.
router.get('/environment', requirePermission('pac_providers.view'), async (req, res, next) => {
  try {
    // CFDIs stamped in the sandbox that are still marked vigente (a test
    // install's own, or left from before the switch existed).
    const [[sandbox]] = await db.query(
      `SELECT COUNT(*) AS n FROM cfdi_documents
        WHERE organization_id = ? AND pac_environment = 'sandbox' AND sat_status IN ('vigente', 'cancel_pending')`,
      [req.orgId],
    );
    res.json({
      data: {
        pac_environment: fiscalEnvironment(),
        sandbox_vigente_count: Number(sandbox?.n || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Stamp each invoice the billing run generates (BIL-33). Off by default;
// organization_mx_profiles.cfdi_auto_stamp. Declared before '/:id'.
router.get('/auto-stamp', requirePermission('pac_providers.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT cfdi_auto_stamp FROM organization_mx_profiles WHERE organization_id = ? AND deleted_at IS NULL',
      [req.orgId],
    );
    res.json({ data: { cfdi_auto_stamp: Boolean(Number(rows[0]?.cfdi_auto_stamp || 0)) } });
  } catch (err) {
    next(err);
  }
});

router.put('/auto-stamp', requirePermission('pac_providers.update'), async (req, res, next) => {
  try {
    const value = req.body?.cfdi_auto_stamp;
    if (typeof value !== 'boolean') {
      throw new AppError('cfdi_auto_stamp must be true or false.', 422, 'VALIDATION_ERROR');
    }
    const [existing] = await db.query(
      'SELECT id FROM organization_mx_profiles WHERE organization_id = ? AND deleted_at IS NULL',
      [req.orgId],
    );
    if (!existing[0]) {
      throw new AppError(
        'Configure the organization fiscal profile (Organization → Fiscal) before turning on automatic stamping.',
        422, 'ORG_MX_PROFILE_MISSING',
      );
    }
    await db.query(
      'UPDATE organization_mx_profiles SET cfdi_auto_stamp = ? WHERE organization_id = ? AND deleted_at IS NULL',
      [value ? 1 : 0, req.orgId],
    );
    await auditLog.log({
      userId: req.user?.id, organizationId: req.orgId, action: 'update',
      tableName: 'organization_mx_profiles', recordId: existing[0].id,
      summary: `${value ? 'Enabled' : 'Disabled'} automatic CFDI stamping of generated invoices`,
    });
    res.json({ data: { cfdi_auto_stamp: value } });
  } catch (err) {
    next(err);
  }
});

// The environment used to be chosen per organization here. It now follows the
// install (see GET above); say so instead of letting '/:id' answer.
router.put('/environment', requirePermission('pac_providers.update'), (_req, _res, next) => {
  next(new AppError(
    'The fiscal environment follows the install mode (live or test) and cannot be set.',
    409, 'FISCAL_ENVIRONMENT_FIXED',
  ));
});

router.get('/', requirePermission('pac_providers.view'), ctrl.list);
router.get('/:id', requirePermission('pac_providers.view'), ctrl.get);
const sealPacCredentials = sealSecretFields({
  username: 'username_encrypted',
  password: 'password_encrypted',
  token: 'token_encrypted',
});

// A PAC's environment is the install's, never chosen (src/utils/installMode.js),
// and the simulator, which stamps nothing real, exists only on a test install.
function applyInstallMode(req, _res, next) {
  try {
    const body = req.body || {};
    if (body.provider_name === 'simulator' && !isTestInstall()) {
      throw new AppError('The simulator PAC is only available on a test install.', 422, 'PAC_SIMULATOR_TEST_ONLY');
    }
    if (req.method === 'POST') body.environment = fiscalEnvironment();
    else delete body.environment;
    req.body = body;
    return next();
  } catch (err) { return next(err); }
}

router.post('/', requirePermission('pac_providers.create'), validate(createPacProvider, { strip: false }), applyInstallMode, guardApiUrl, sealPacCredentials, ctrl.create);
router.put('/:id', requirePermission('pac_providers.update'), validate(updatePacProvider, { strip: false }), applyInstallMode, guardApiUrl, sealPacCredentials, ctrl.update);
router.delete('/:id', requirePermission('pac_providers.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('pac_providers.update'), ctrl.restore);

module.exports = router;
