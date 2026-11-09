// =============================================================================
// VigaBSS 5.0 — Security Admin Routes (§17)
// Covers: webauthn_credentials, admin_ip_allowlist, password_policies,
//         api_key_rate_limits
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const {
  updatePasswordPolicy,
  createAdminIpAllowlist,
  createLoginIpBlock,
} = require('../middleware/schemas/security');
const { AppError, ValidationError, NotFoundError, ForbiddenError } = require('../utils/errors');
const passwordPolicyService = require('../services/passwordPolicyService');
const net = require('net');
const config = require('../config');
const loginSecurity = require('../services/loginSecurityService');
const { isInstallOperator, OPERATOR_ONLY_MESSAGE } = require('../services/installOperator');
const { parseEntry, isAllowed } = require('../middleware/ipAllowlist');
const {
  clientIp,
  environmentOverrideConfigured,
  getAdminIpAllowlistStatus,
  listActiveEntries,
} = require('../middleware/adminIpAllowlist');

const router = Router();

function requireInteractiveJwt(req, _res, next) {
  if (req.user?.apiTokenId) {
    return next(new ForbiddenError('API token rate-policy changes require an interactive user session'));
  }
  return next();
}

router.use(authenticate);
router.use(orgScope);

// ---------------------------------------------------------------------------
// WebAuthn Credentials
// ---------------------------------------------------------------------------
// Not implemented (SEC-17): there is no registration challenge, no
// attestation check and no sign-in ceremony, so a stored credential would
// protect nothing. Registration is refused rather than accepted as a security
// control that does not exist; listing and revoking remain for rows that
// already exist.

// GET /webauthn — list WebAuthn credentials for current user
router.get('/webauthn', requirePermission('webauthn.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM webauthn_credentials WHERE organization_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY id DESC',
      [req.orgId, req.user.id],
    );
    res.json({ data: rows, meta: { enforced: false } });
  } catch (err) {
    next(err);
  }
});

// POST /webauthn — refused until WebAuthn is implemented
router.post('/webauthn', requirePermission('webauthn.create'), (_req, _res, next) => {
  next(new AppError(
    'WebAuthn sign-in is not implemented, so credentials cannot be registered. Use TOTP two-factor authentication.',
    501,
    'NOT_IMPLEMENTED',
  ));
});

// DELETE /webauthn/:id — revoke WebAuthn credential
router.delete('/webauthn/:id', requirePermission('webauthn.delete'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE webauthn_credentials SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.id, req.orgId, req.user.id],
    );
    if (result.affectedRows === 0) throw new NotFoundError('WebAuthn credential');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Admin IP Allowlist
// ---------------------------------------------------------------------------

function validatedCidr(value) {
  const cidr = typeof value === 'string' ? value.trim() : '';
  if (!cidr || !parseEntry(cidr)) {
    throw new ValidationError('Enter a valid IPv4 address or CIDR range', [
      { field: 'cidr', message: 'Use an IPv4 address such as 203.0.113.5 or CIDR such as 203.0.113.0/24' },
    ]);
  }
  return cidr;
}

async function assertCurrentIpRemainsAllowed(req, candidateEntries) {
  // The environment override takes precedence, so database edits cannot alter
  // the policy currently protecting the request.
  if (environmentOverrideConfigured() || candidateEntries.length === 0) return;
  const parsed = candidateEntries.map(entry => parseEntry(entry.cidr)).filter(Boolean);
  if (parsed.length > 0 && isAllowed(clientIp(req), parsed)) return;
  throw new ValidationError(
    'Activation refused because the resulting allowlist would exclude your current IP address',
    [{ field: 'is_active', message: 'Add the current IP shown in the allowlist status before activating this policy' }],
  );
}

// GET /admin-ip-allowlist/status — setup state used by the persistent GUI warning
router.get('/admin-ip-allowlist/status', requirePermission('admin_ip_allowlist.view'), async (req, res, next) => {
  try {
    const status = await getAdminIpAllowlistStatus(req.orgId, clientIp(req));
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
});

// GET /admin-ip-allowlist — list org admin IP allowlist
router.get('/admin-ip-allowlist', requirePermission('admin_ip_allowlist.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM admin_ip_allowlist WHERE organization_id = ? AND deleted_at IS NULL ORDER BY id DESC',
      [req.orgId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin-ip-allowlist — add entry
router.post('/admin-ip-allowlist', requirePermission('admin_ip_allowlist.create'), validate(createAdminIpAllowlist, { strip: false }), async (req, res, next) => {
  try {
    const { cidr, description, is_active } = req.body;
    const cidrValue = validatedCidr(cidr);
    const activate = is_active === true;
    if (activate) {
      const activeEntries = await listActiveEntries(req.orgId);
      await assertCurrentIpRemainsAllowed(req, [...activeEntries, { cidr: cidrValue }]);
    }
    const [result] = await db.query(
      `INSERT INTO admin_ip_allowlist (organization_id, cidr, description, is_active, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      // New rules are staged inactive unless the user explicitly activates.
      [req.orgId, cidrValue, description || null, activate ? 1 : 0, req.user.id],
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// PUT /admin-ip-allowlist/:id — update entry
router.put('/admin-ip-allowlist/:id', requirePermission('admin_ip_allowlist.update'), async (req, res, next) => {
  try {
    const { cidr, description, is_active } = req.body;
    const [[current]] = await db.query(
      `SELECT id, organization_id, cidr, description, is_active
       FROM admin_ip_allowlist
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.id, req.orgId],
    );
    if (!current) throw new NotFoundError('Admin IP allowlist entry');

    const cidrValue = cidr !== undefined ? validatedCidr(cidr) : current.cidr;
    const activate = is_active !== undefined ? is_active === true : Boolean(current.is_active);
    const activeEntries = await listActiveEntries(req.orgId);
    const candidateEntries = activeEntries.filter(entry => Number(entry.id) !== Number(current.id));
    if (activate) candidateEntries.push({ ...current, cidr: cidrValue, is_active: 1 });
    await assertCurrentIpRemainsAllowed(req, candidateEntries);

    const [result] = await db.query(
      `UPDATE admin_ip_allowlist
       SET cidr = COALESCE(?, cidr),
           description = ?,
           is_active = COALESCE(?, is_active),
           updated_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [cidrValue, description !== undefined ? description : current.description, activate ? 1 : 0, req.params.id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Admin IP allowlist entry');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin-ip-allowlist/:id — delete entry
router.delete('/admin-ip-allowlist/:id', requirePermission('admin_ip_allowlist.delete'), async (req, res, next) => {
  try {
    const activeEntries = await listActiveEntries(req.orgId);
    const candidateEntries = activeEntries.filter(entry => Number(entry.id) !== Number(req.params.id));
    await assertCurrentIpRemainsAllowed(req, candidateEntries);
    const [result] = await db.query(
      'DELETE FROM admin_ip_allowlist WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('Admin IP allowlist entry');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Blocked IPs at sign-in (migration 013)
// ---------------------------------------------------------------------------
// A block covers every sign-in route of the install (staff, 2FA, portal), not
// one organization, so besides the permission it is for the install operator
// only: a tenant admin must not lock another tenant's users out, or lift a
// block an attack on another tenant earned. Automatic blocks come from
// services/loginSecurityService.js.

async function requireInstallOperator(req, _res, next) {
  try {
    if (!(await isInstallOperator(req))) return next(new ForbiddenError(OPERATOR_ONLY_MESSAGE));
    return next();
  } catch (err) {
    return next(err);
  }
}

function blockView(row) {
  return {
    id: Number(row.id),
    ip_address: row.ip_address,
    source: row.source,
    failures: Number(row.failures) || 0,
    refused_count: Number(row.refused_count) || 0,
    blocked_until: row.blocked_until || null,
    note: row.note || null,
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    lifted_at: row.lifted_at || null,
    lifted_by: row.lifted_by === null || row.lifted_by === undefined ? null : Number(row.lifted_by),
    created_at: row.created_at,
    active: row.active !== undefined ? Boolean(row.active)
      : (!row.lifted_at && (!row.blocked_until || new Date(row.blocked_until) > new Date())),
  };
}

// GET /login-ip-blocks — the blocks, active first. ?active=true for active only.
router.get('/login-ip-blocks', requirePermission('login_ip_blocks.view'), requireInstallOperator, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const activeOnly = req.query.active === 'true';
    const { rows, total } = await loginSecurity.listBlocks({ limit, offset: (page - 1) * limit, activeOnly });
    res.json({
      data: rows.map(blockView),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      settings: {
        enabled: Boolean(config.loginIpBlock?.enabled),
        threshold: config.loginIpBlock?.threshold ?? null,
        window_minutes: config.loginIpBlock?.windowMinutes ?? null,
        hours: config.loginIpBlock?.hours ?? null,
      },
      your_ip: loginSecurity.clientIp(req) || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /login-ip-blocks — block an IP by hand ({ ip, hours?, note? }).
router.post('/login-ip-blocks', requirePermission('login_ip_blocks.manage'), requireInstallOperator,
  validate(createLoginIpBlock, { strip: false }), async (req, res, next) => {
    try {
      const raw = String(req.body.ip).trim();
      const ip = raw.startsWith('::ffff:') && net.isIPv4(raw.slice(7)) ? raw.slice(7) : raw;
      if (!net.isIP(ip)) {
        throw new ValidationError('Not an IP address', [{ field: 'ip', message: 'Enter one IPv4 or IPv6 address' }]);
      }
      if (loginSecurity.isPrivateAddress(ip)) {
        // A private address is the office, the server or a proxy in front of
        // it: blocking it could lock everyone out at once.
        throw new ValidationError('Private addresses cannot be blocked', [{ field: 'ip', message: 'This is a private, loopback or shared address; blocking it could lock everyone out' }]);
      }
      if (ip === loginSecurity.clientIp(req)) {
        throw new ValidationError('That is your own IP', [{ field: 'ip', message: 'You would lock yourself out' }]);
      }
      if (await loginSecurity.activeBlock(ip)) {
        throw new AppError('This IP is already blocked', 409, 'ALREADY_BLOCKED');
      }
      const hours = req.body.hours === null || req.body.hours === undefined ? null : Math.round(Number(req.body.hours));
      const row = await loginSecurity.blockIp({
        ip, source: 'manual', hours, note: req.body.note ? String(req.body.note).slice(0, 255) : null, createdBy: req.user.id,
      });
      await loginSecurity.record({
        action: 'login_ip_blocked',
        organizationId: req.orgId,
        userId: req.user.id,
        entityType: 'login_ip_blocks',
        entityId: Number(row.id),
        ctx: { ip },
        extra: { hours, note: row.note || null, by_ip: loginSecurity.clientIp(req) || null },
      });
      res.status(201).json({ data: blockView(row) });
    } catch (err) {
      next(err);
    }
  });

// POST /login-ip-blocks/:id/lift — lift a block now.
router.post('/login-ip-blocks/:id/lift', requirePermission('login_ip_blocks.manage'), requireInstallOperator, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || id < 1) throw new NotFoundError('Blocked IP');
    const { lifted, row } = await loginSecurity.liftBlock(id, req.user.id);
    if (!row) throw new NotFoundError('Blocked IP');
    if (lifted) {
      await loginSecurity.record({
        action: 'login_ip_unblocked',
        organizationId: req.orgId,
        userId: req.user.id,
        entityType: 'login_ip_blocks',
        entityId: id,
        ctx: { ip: row.ip_address },
        extra: { source: row.source },
      });
    }
    res.json({ data: blockView(row), lifted });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Password Policy
// ---------------------------------------------------------------------------

// GET /password-policy — the policy in force for this organization. With no
// stored row the built-in defaults apply (configured: false).
router.get('/password-policy', requirePermission('password_policy.view'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      'SELECT * FROM password_policies WHERE organization_id = ? LIMIT 1',
      [req.orgId],
    );
    if (!row) return res.json({ data: { ...passwordPolicyService.DEFAULT_POLICY, configured: false } });
    res.json({ data: { ...row, configured: true } });
  } catch (err) {
    next(err);
  }
});

// Columns PUT may write. A zero for the two optional limits means "off" and
// is stored as NULL, as the column comments define.
const POLICY_BOOLEANS = ['require_uppercase', 'require_lowercase', 'require_digits', 'require_special_chars'];
const POLICY_NULLABLE = ['max_repeated_chars', 'rotation_days'];
const POLICY_INTEGERS = ['min_length', 'history_count', 'lockout_attempts', 'lockout_duration_minutes'];

// PUT /password-policy — update org password policy (upsert by org). Only the
// fields sent change; the rest keep their stored or default value. Enforced
// by passwordPolicyService on every password set and sign-in (SEC-17).
router.put('/password-policy', requirePermission('password_policy.update'), validate(updatePasswordPolicy, { strip: false }), async (req, res, next) => {
  try {
    const body = { ...req.body };

    const values = {};
    for (const key of POLICY_BOOLEANS) if (body[key] !== undefined) values[key] = body[key] ? 1 : 0;
    for (const key of POLICY_NULLABLE) if (body[key] !== undefined) values[key] = body[key] === 0 ? null : body[key];
    for (const key of POLICY_INTEGERS) if (body[key] !== undefined) values[key] = body[key];
    const columns = Object.keys(values);
    if (columns.length === 0) {
      throw new ValidationError('Send at least one password policy field');
    }

    // Columns not sent take the built-in default on first insert, so the
    // stored row never starts stricter than what was in force before it.
    const insertValues = { ...passwordPolicyService.DEFAULT_POLICY, ...values };
    const insertColumns = Object.keys(insertValues);
    await db.query(
      `INSERT INTO password_policies (organization_id, ${insertColumns.join(', ')})
       VALUES (?, ${insertColumns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${columns.map(c => `${c} = VALUES(${c})`).join(', ')}, updated_at = NOW()`,
      [req.orgId, ...insertColumns.map(c => insertValues[c])],
    );

    const [[row]] = await db.query('SELECT * FROM password_policies WHERE organization_id = ? LIMIT 1', [req.orgId]);
    res.json({ data: { ...row, configured: true } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// API Key Rate Limits
// ---------------------------------------------------------------------------

const UINT32_MAX = 0xFFFFFFFF;
const UINT16_MAX = 0xFFFF;
const UINT64_MAX = 18446744073709551615n;

function apiTokenIdParam(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ValidationError('Invalid API token ID', [{ field: 'tokenId', message: 'tokenId must be a positive integer' }]);
  }
  try {
    if (BigInt(value) > UINT64_MAX) throw new Error('out of range');
  } catch (_err) {
    throw new ValidationError('Invalid API token ID', [{ field: 'tokenId', message: 'tokenId is outside the database ID range' }]);
  }
  return value;
}

function optionalRateLimit(body, field, max) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError('Invalid API token rate limit', [{
      field,
      message: `${field} must be a positive integer no greater than ${max}`,
    }]);
  }
  return value;
}

// GET /api-key-rate-limits — list
router.get('/api-key-rate-limits', requirePermission('api_key_rate_limits.view'), async (req, res, next) => {
  try {
    // API tokens and their policies are control-plane data, including when the
    // current organization routes subscriber data to an isolated database.
    const [rows] = await db.withPrimaryContext(() => db.query(
      'SELECT * FROM api_key_rate_limits WHERE organization_id = ? ORDER BY id DESC',
      [req.orgId],
    ));
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// PUT /api-key-rate-limits/:tokenId — set rate limit for token
router.put('/api-key-rate-limits/:tokenId', requireInteractiveJwt, requirePermission('api_key_rate_limits.update'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const tokenId = apiTokenIdParam(req.params.tokenId);
    const requestsPerMinute = optionalRateLimit(body, 'requests_per_minute', UINT32_MAX);
    const requestsPerHour = optionalRateLimit(body, 'requests_per_hour', UINT32_MAX);
    const requestsPerDay = optionalRateLimit(body, 'requests_per_day', UINT32_MAX);
    const burstSize = optionalRateLimit(body, 'burst_size', UINT16_MAX);
    if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
      throw new ValidationError('Invalid API token rate limit', [{ field: 'is_active', message: 'is_active must be a boolean' }]);
    }
    const insertActive = body.is_active === undefined ? 1 : (body.is_active ? 1 : 0);
    const updateActive = body.is_active === undefined ? null : 1;

    await db.withPrimaryContext(async () => {
      // Never trust the path ID alone: api_token_id is globally unique and an
      // unchecked upsert let one tenant create or alter another tenant's row.
      const [tokens] = await db.query(
        `SELECT id FROM api_tokens
          WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
          LIMIT 2`,
        [tokenId, req.orgId],
      );
      if (!Array.isArray(tokens) || tokens.length !== 1) throw new NotFoundError('API token');

      await db.query(
        `INSERT INTO api_key_rate_limits
          (organization_id, api_token_id, requests_per_minute, requests_per_hour,
           requests_per_day, burst_size, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           organization_id = VALUES(organization_id),
           requests_per_minute = VALUES(requests_per_minute),
           requests_per_hour = VALUES(requests_per_hour),
           requests_per_day = VALUES(requests_per_day),
           burst_size = VALUES(burst_size),
           is_active = IF(? IS NULL, is_active, VALUES(is_active)),
           updated_at = NOW()`,
        [
          req.orgId,
          tokenId,
          requestsPerMinute,
          requestsPerHour,
          requestsPerDay,
          burstSize,
          insertActive,
          updateActive,
        ],
      );
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
