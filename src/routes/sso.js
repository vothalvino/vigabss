// =============================================================================
// VigaBSS 5.0 — SSO Routes (P2.1)
// =============================================================================
// Mounts both the browser-facing redirect/callback endpoints (no auth required)
// and the admin config/group-mapping management endpoints (JWT + RBAC required).
//
// URL structure (orgId = numeric organization ID):
//
//   SAML 2.0
//   GET  /sso/:orgId/saml/login         Redirect to IdP
//   GET  /sso/:orgId/saml/metadata      SP metadata XML (for IdP registration)
//   POST /sso/:orgId/saml/acs           ACS endpoint (IdP posts assertion here)
//
//   OIDC
//   GET  /sso/:orgId/oidc/login         Redirect to IdP authorization endpoint
//   GET  /sso/:orgId/oidc/callback      OIDC authorization code callback
//
//   Admin (JWT + owner/admin role in the SAME organization as :orgId;
//   installation-global identities may administer any org; API tokens never)
//   GET  /sso/:orgId/saml/config        Get SAML config
//   PUT  /sso/:orgId/saml/config        Create or update SAML config
//   GET  /sso/:orgId/oidc/config        Get OIDC config
//   PUT  /sso/:orgId/oidc/config        Create or update OIDC config
//   GET  /sso/:orgId/saml/group-mappings    Get SAML group mappings
//   PUT  /sso/:orgId/saml/group-mappings    Replace SAML group mappings
//   GET  /sso/:orgId/oidc/group-mappings    Get OIDC group mappings
//   PUT  /sso/:orgId/oidc/group-mappings    Replace OIDC group mappings
// =============================================================================

const { Router } = require('express');
const ssoService = require('../services/ssoService');
const authService = require('../services/authService');
const { enforceAdminIpAllowlist } = require('../middleware/adminIpAllowlist');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requireRole } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const ssoSchemas = require('../middleware/schemas/sso');
const { ForbiddenError } = require('../utils/errors');
const config = require('../config');

const router = Router();

// ---------------------------------------------------------------------------
// Helper: strip sensitive fields from a config row before returning to client
// ---------------------------------------------------------------------------
function sanitizeConfig(cfg) {
  const { saml_sp_private_key: _k, oidc_client_secret: _s, ...safe } = cfg;
  return safe;
}

// ---------------------------------------------------------------------------
// Helper: parse and validate orgId from URL param
// ---------------------------------------------------------------------------
function parseOrgId(req, res) {
  const orgId = parseInt(req.params.orgId, 10);
  if (!orgId || orgId < 1) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid orgId' } });
    return null;
  }
  return orgId;
}

// ---------------------------------------------------------------------------
// Helper: finish an SSO login. An account with TOTP 2FA enabled gets a
// second-factor challenge (bound to this org) instead of a session; the SPA
// login page completes it via POST /auth/login/2fa.
// ---------------------------------------------------------------------------
async function finishSsoLogin(res, user, orgId, spaBase) {
  if (authService.requiresSecondFactor(user)) {
    const challenge = authService.createSsoMfaChallenge(user, orgId);
    return res.redirect(`${config.appUrl}/login#mfa_token=${encodeURIComponent(challenge.mfaToken)}`);
  }
  const tokens = await ssoService.mintTokens(user, orgId);
  // The SPA should read accessToken from the fragment (not sent to the server).
  const spaUrl = `${spaBase}#` +
    `accessToken=${encodeURIComponent(tokens.accessToken)}&` +
    `refreshToken=${encodeURIComponent(tokens.refreshToken)}&` +
    `expiresIn=${tokens.expiresIn}`;
  return res.redirect(spaUrl);
}

// ---------------------------------------------------------------------------
// Global SSO feature-flag guard — applied to all routes in this router
// ---------------------------------------------------------------------------
router.use((_req, res, next) => {
  if (!config.features.sso) {
    return res.status(404).json({
      error: { code: 'FEATURE_DISABLED', message: 'The sso feature is not enabled' },
    });
  }
  next();
});

// =============================================================================
// SAML 2.0 — browser-facing endpoints (no JWT required)
// =============================================================================

// GET /sso/:orgId/saml/login
// Redirect the browser to the IdP's SSO URL with an AuthnRequest.
router.get('/:orgId/saml/login', async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const url = await ssoService.generateSamlLoginUrl(orgId);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// GET /sso/:orgId/saml/metadata
// Return the SP SAML metadata XML so the IdP admin can register this SP.
router.get('/:orgId/saml/metadata', async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const xml = await ssoService.getSamlMetadata(orgId);
    res.set('Content-Type', 'application/xml').send(xml);
  } catch (err) {
    next(err);
  }
});

// POST /sso/:orgId/saml/acs
// Assertion Consumer Service — the IdP POSTs the SAML Response here.
// Validates the assertion, resolves/creates the local user, mints tokens,
// then redirects the browser to the SPA with the access token in the URL fragment.
router.post('/:orgId/saml/acs', async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;

    const profile  = await ssoService.processSamlAssertion(orgId, req.body);
    const cfg      = await ssoService.getConfig(orgId, 'saml');
    const mappings = await ssoService.getGroupMappings(cfg.id);

    const { user } = await ssoService.findOrCreateSsoUser(orgId, profile, cfg, mappings);
    await finishSsoLogin(res, user, orgId, `${config.appUrl}/sso/callback`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// OIDC — browser-facing endpoints (no JWT required)
// =============================================================================

// GET /sso/:orgId/oidc/login
// Redirect the browser to the IdP authorization endpoint.
router.get('/:orgId/oidc/login', async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const { redirectTo } = req.query;
    const url = await ssoService.generateOidcLoginUrl(orgId, redirectTo);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// GET /sso/:orgId/oidc/callback
// OIDC authorization code callback — the IdP redirects here with code+state.
router.get('/:orgId/oidc/callback', async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;

    const { profile, redirectTo } = await ssoService.processOidcCallback(orgId, req);
    const cfg      = await ssoService.getConfig(orgId, 'oidc');
    const mappings = await ssoService.getGroupMappings(cfg.id);

    const { user } = await ssoService.findOrCreateSsoUser(orgId, profile, cfg, mappings);
    await finishSsoLogin(res, user, orgId, redirectTo || `${config.appUrl}/sso/callback`);
  } catch (err) {
    next(err);
  }
});

// =============================================================================
// Admin config endpoints — require JWT + owner or admin org role
// =============================================================================

/**
 * Bind the URL :orgId to the caller. An owner/admin may only administer the
 * SSO of the organization they are acting in (req.orgId); only an
 * installation-global browser identity may target another one. API tokens are
 * refused outright: SSO config decides who can sign in, which is not a
 * delegable integration scope.
 */
function bindOrgParam(req, _res, next) {
  try {
    if (req.user?.apiTokenId) {
      throw new ForbiddenError('API tokens cannot manage SSO configuration');
    }
    const target = parseInt(req.params.orgId, 10);
    if (!target || target < 1) return next();
    if (Number(target) === Number(req.orgId)) return next();
    // Same rule requirePermission applies: a validated global browser identity.
    if (req.user?.hasGlobalOrganizationAccess === true) return next();
    throw new ForbiddenError('You can only manage SSO for your active organization');
  } catch (err) {
    next(err);
  }
}

// SSO configuration is admin-only and behind the admin IP allowlist (SEC-26);
// the browser login flow above is not.
const adminGuard = [authenticate, orgScope, bindOrgParam, requireRole('owner', 'admin'), enforceAdminIpAllowlist];

// GET /sso/:orgId/saml/config
router.get('/:orgId/saml/config', ...adminGuard, async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const cfg = await ssoService.getConfig(orgId, 'saml');
    if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'SAML config not found' } });
    res.json({ data: sanitizeConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

// PUT /sso/:orgId/saml/config
router.put('/:orgId/saml/config', ...adminGuard,
  validate(ssoSchemas.samlConfig),
  async (req, res, next) => {
    try {
      const orgId = parseOrgId(req, res);
      if (!orgId) return;
      const cfg = await ssoService.saveConfig(orgId, 'saml', req.body);
      res.json({ data: sanitizeConfig(cfg) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /sso/:orgId/oidc/config
router.get('/:orgId/oidc/config', ...adminGuard, async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const cfg = await ssoService.getConfig(orgId, 'oidc');
    if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OIDC config not found' } });
    res.json({ data: sanitizeConfig(cfg) });
  } catch (err) {
    next(err);
  }
});

// PUT /sso/:orgId/oidc/config
router.put('/:orgId/oidc/config', ...adminGuard,
  validate(ssoSchemas.oidcConfig),
  async (req, res, next) => {
    try {
      const orgId = parseOrgId(req, res);
      if (!orgId) return;
      const cfg = await ssoService.saveConfig(orgId, 'oidc', req.body);
      res.json({ data: sanitizeConfig(cfg) });
    } catch (err) {
      next(err);
    }
  },
);

// GET /sso/:orgId/saml/group-mappings
router.get('/:orgId/saml/group-mappings', ...adminGuard, async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const cfg = await ssoService.getConfig(orgId, 'saml');
    if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'SAML config not found' } });
    const mappings = await ssoService.getGroupMappings(cfg.id);
    res.json({ data: mappings });
  } catch (err) {
    next(err);
  }
});

// PUT /sso/:orgId/saml/group-mappings
router.put('/:orgId/saml/group-mappings', ...adminGuard,
  validate(ssoSchemas.groupMappings),
  async (req, res, next) => {
    try {
      const orgId = parseOrgId(req, res);
      if (!orgId) return;
      const cfg = await ssoService.getConfig(orgId, 'saml');
      if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'SAML config not found' } });
      const mappings = await ssoService.saveGroupMappings(cfg.id, req.body.mappings || []);
      res.json({ data: mappings });
    } catch (err) {
      next(err);
    }
  },
);

// GET /sso/:orgId/oidc/group-mappings
router.get('/:orgId/oidc/group-mappings', ...adminGuard, async (req, res, next) => {
  try {
    const orgId = parseOrgId(req, res);
    if (!orgId) return;
    const cfg = await ssoService.getConfig(orgId, 'oidc');
    if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OIDC config not found' } });
    const mappings = await ssoService.getGroupMappings(cfg.id);
    res.json({ data: mappings });
  } catch (err) {
    next(err);
  }
});

// PUT /sso/:orgId/oidc/group-mappings
router.put('/:orgId/oidc/group-mappings', ...adminGuard,
  validate(ssoSchemas.groupMappings),
  async (req, res, next) => {
    try {
      const orgId = parseOrgId(req, res);
      if (!orgId) return;
      const cfg = await ssoService.getConfig(orgId, 'oidc');
      if (!cfg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'OIDC config not found' } });
      const mappings = await ssoService.saveGroupMappings(cfg.id, req.body.mappings || []);
      res.json({ data: mappings });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
