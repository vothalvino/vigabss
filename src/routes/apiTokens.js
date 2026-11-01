// =============================================================================
// VigaBSS 5.0 — API Token Routes
// =============================================================================

const crypto = require('crypto');
const { Router } = require('express');
const ApiToken = require('../models/ApiToken');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createApiToken, updateApiToken } = require('../middleware/schemas/apiTokens');
const { validateScopes, listAvailableScopes } = require('../utils/scopes');
const { ValidationError, ForbiddenError } = require('../utils/errors');
const db = require('../config/database');

const router = Router();

// token_hash never leaves the server (SEC-19). It is a SHA-256 of a 256-bit
// secret, so it cannot be reversed, but nothing reads it either.
function serializeToken(token) {
  if (!token) return token;
  const { token_hash: _hash, ...rest } = token;
  return rest;
}
const ctrl = crudController(ApiToken, { serialize: serializeToken });

// A token's scopes must be a non-empty, valid list. null means unrestricted,
// so it is never accepted from a client.
function requireScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ValidationError('scopes must list at least one scope; use ["*:write"] for full access', [
      { field: 'scopes', message: 'At least one scope is required' },
    ]);
  }
  const { valid, errors } = validateScopes(scopes);
  if (!valid) throw new ValidationError('Invalid scopes', errors);
  return JSON.stringify(scopes);
}

function requireInteractiveJwt(req, _res, next) {
  if (req.user?.apiTokenId) {
    return next(new ForbiddenError('API token lifecycle changes require an interactive user session'));
  }
  return next();
}

router.use(authenticate);
router.use(orgScope);
// API-token authentication necessarily happens before tenant routing, so token
// lifecycle records are control-plane data in the primary database even when
// their owning organization uses an isolated subscriber database.
router.use((req, res, next) => db.withPrimaryContext(() => next()));

// GET /api-tokens/scopes — list all available scopes (for UI token-creation forms)
router.get('/scopes', requirePermission('api_tokens.view'), (_req, res) => {
  res.json({ data: listAvailableScopes() });
});

router.get('/', requirePermission('api_tokens.view'), ctrl.list);
router.get('/:id', requirePermission('api_tokens.view'), ctrl.get);

// Create token — generate plaintext, store SHA-256 hash, validate scopes
router.post('/', requireInteractiveJwt, requirePermission('api_tokens.create'), validate(createApiToken, { strip: true }), async (req, res, next) => {
  try {
    // Stored as JSON (MySQL JSON column)
    req.body.scopes = requireScopes(req.body.scopes);

    const plaintext = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');

    req.body.organization_id = req.orgId;
    // SECURITY: bind the token to the authenticated creator. user_id is fillable
    // and was previously mass-assignable from the body, letting an
    // api_tokens.create holder mint a token impersonating another user (e.g. the
    // admin user_id=1) and inherit that user's role on every request.
    req.body.user_id = req.user.id;
    req.body.token_hash = tokenHash;

    const token = await ApiToken.create(req.body);
    res.status(201).json({ data: { ...serializeToken(token), token: plaintext } });
  } catch (err) {
    next(err);
  }
});

// Update token — validate scopes if changing
router.put('/:id', requireInteractiveJwt, requirePermission('api_tokens.update'), validate(updateApiToken, { strip: true }), async (req, res, next) => {
  try {
    // `scopes: null` used to widen a token to unrestricted; it is now a 422.
    if (req.body.scopes !== undefined) req.body.scopes = requireScopes(req.body.scopes);

    const old = await ApiToken.findByIdOrFail(req.params.id, req.orgId);
    const record = await ApiToken.update(req.params.id, req.body, req.orgId);
    const auditLog = require('../services/auditLog');
    await auditLog.log({
      userId: req.user?.id,
      organizationId: req.orgId,
      action: 'update',
      tableName: ApiToken.tableName,
      recordId: record.id,
      oldValues: serializeToken(old),
      newValues: req.body,
    });
    res.json({ data: serializeToken(record) });
  } catch (err) {
    next(err);
  }
});

// Revocation is one-way: revoked_at is not part of the update schema, so PUT
// cannot clear it, and revoking an already revoked token changes nothing.
router.post('/:id/revoke', requireInteractiveJwt, requirePermission('api_tokens.update'), async (req, res, next) => {
  try {
    await ApiToken.findByIdOrFail(req.params.id, req.orgId);
    await db.query(
      'UPDATE api_tokens SET revoked_at = NOW() WHERE id = ? AND organization_id <=> ? AND revoked_at IS NULL',
      [req.params.id, req.orgId],
    );
    const record = await ApiToken.findByIdOrFail(req.params.id, req.orgId);
    const auditLog = require('../services/auditLog');
    await auditLog.log({
      userId: req.user?.id,
      organizationId: req.orgId,
      action: 'revoke',
      tableName: ApiToken.tableName,
      recordId: record.id,
      newValues: { revoked_at: record.revoked_at },
    });
    res.json({ data: serializeToken(record) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireInteractiveJwt, requirePermission('api_tokens.delete'), ctrl.destroy);
router.post('/:id/restore', requireInteractiveJwt, requirePermission('api_tokens.update'), ctrl.restore);

module.exports = router;
