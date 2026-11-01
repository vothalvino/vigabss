// =============================================================================
// VigaBSS 5.0 — PPPoE Diagnostics + Event Ingest Routes
// =============================================================================
// Mixed-auth router:
//   - POST /events: machine-to-machine shared-secret auth (no JWT), for an
//     operator-run collector that serves the whole installation
//   - POST /events/tenant: an organization API token holding only
//     pppoe_events:ingest; the NAS must belong to the token's organization
//   - GET  /events, /diagnostics/*: JWT authenticate + orgScope + requirePermission
// =============================================================================

const { Router } = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validatePppoeEvent } = require('../middleware/validatePppoeEvent');
const pppoeDiagnosticsService = require('../services/pppoeDiagnosticsService');
const pppoeReadinessService = require('../services/pppoeReadinessService');
const { deriveEventIdentity } = require('../services/pppoeEventCollector');
const { ValidationError, ForbiddenError } = require('../utils/errors');
const PppoeEventLog = require('../models/PppoeEventLog');
const { CacheStore, apiTokenConfiguredLimiter } = require('../middleware/rateLimit');

const router = Router();

// ---------------------------------------------------------------------------
// Machine-to-machine secret auth helper
// ---------------------------------------------------------------------------

/**
 * Verify the shared secret for M2M event ingest.
 * Checks X-Pppoe-Secret header or Authorization: Bearer <secret>.
 */
function verifyEventsSecret(req) {
  // Its own secret only: sharing RADIUS_ACCOUNTING_SECRET would let every
  // holder of the accounting secret write PPPoE events for any tenant.
  const secret = process.env.PPPOE_EVENTS_SECRET;
  if (!secret) return false;

  const headerSecret = req.headers['x-pppoe-secret'];
  const authHeader = req.headers['authorization'];
  const expectedBuffer = Buffer.from(String(secret));
  const candidates = [
    headerSecret,
    authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null,
  ];
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const providedBuffer = Buffer.from(String(candidate));
    return expectedBuffer.length === providedBuffer.length
      && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  });
}

function requireEventsSecret(req, res, next) {
  if (!verifyEventsSecret(req)) {
    return res.status(401).json({ error: 'Invalid or missing X-Pppoe-Secret' });
  }
  next();
}

/** Store one validated event for a NAS whose organization is already known. */
async function recordEvent(nas, body) {
  const message = body.line || body.message;
  const parsed = pppoeDiagnosticsService.parseRouterOsLogLine(message);
  const identity = deriveEventIdentity(message);
  const data = {
    // Never accept organization_id from the caller. NAS ownership is the
    // only tenant authority for event ingest.
    organization_id: nas.organization_id,
    nas_id: nas.id,
    username: body.username || identity.username || null,
    mac: body.mac || identity.mac || null,
    stage: body.stage || parsed?.stage || 'OTHER',
    severity: body.severity || parsed?.severity || 'info',
    message,
    reason_code: body.reason_code || parsed?.reason_code || null,
  };
  // Omit the column entirely when the caller supplies no timestamp so the DB
  // DEFAULT CURRENT_TIMESTAMP is used. Explicit NULL violates the NOT NULL
  // column and bypasses the intended default.
  if (body.logged_at !== undefined) data.logged_at = body.logged_at;

  return PppoeEventLog.create(data);
}

function unknownNasError() {
  return new ValidationError('Validation failed', [
    { field: 'nas_id', message: 'nas_id does not identify an active tenant-owned NAS record' },
  ]);
}

// ---------------------------------------------------------------------------
// POST /pppoe/events — M2M event log ingest (no JWT required)
// ---------------------------------------------------------------------------

router.post('/events', requireEventsSecret, validatePppoeEvent, async (req, res, next) => {
  try {
    const { nas_id: nasId } = req.body;
    const [nasRows] = await db.query(
      `SELECT n.id, n.organization_id
         FROM nas n
        WHERE n.id = ?
          AND n.status = 'active'
          AND n.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM organization_database_configs odc
             WHERE odc.organization_id = n.organization_id
               AND odc.isolation_mode = 'isolated'
          )
        LIMIT 1`,
      [nasId],
    );
    const nas = nasRows[0];
    if (!nas || nas.organization_id === null) throw unknownNasError();

    const record = await recordEvent(nas, req.body);
    return res.status(201).json({ data: record });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Authenticated routes (JWT + orgScope) — must come after the M2M POST
// ---------------------------------------------------------------------------

router.use(authenticate);
router.use(orgScope);

// One budget per organization token, like /radius/accounting/tenant. The
// install-wide collector limiter (rateLimit.js) bounds the path as a whole.
const tenantIngestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.min(Math.max(Number.parseInt(process.env.PPPOE_EVENTS_REQUESTS_PER_MINUTE || '6000', 10) || 6000, 1), 60000),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: req => `pppoe-events:${req.orgId}:${req.user?.apiTokenId || 'missing-token'}`,
  message: { error: { code: 'RATE_LIMITED', message: 'PPPoE event ingest rate exceeded' } },
  store: new CacheStore('rl_pppoe_events:'),
});

// POST /pppoe/events/tenant — event ingest for one organization. The token
// fixes the organization before the NAS lookup, so a collector cannot write
// events for a NAS that belongs to anyone else.
router.post('/events/tenant', tenantIngestLimiter, apiTokenConfiguredLimiter, requirePermission('pppoe_events.ingest'), validatePppoeEvent, async (req, res, next) => {
  try {
    if (!req.user.apiTokenId) {
      throw new ForbiddenError('Tenant PPPoE event ingest requires an organization API token (X-API-Key)');
    }
    let scopes = req.user.scopes;
    if (typeof scopes === 'string') {
      try { scopes = JSON.parse(scopes); } catch { scopes = null; }
    }
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'pppoe_events:ingest') {
      throw new ForbiddenError('Collector token must contain only pppoe_events:ingest');
    }

    const [nasRows] = await db.query(
      `SELECT id, organization_id FROM nas
        WHERE id = ? AND organization_id = ?
          AND status = 'active' AND deleted_at IS NULL
        LIMIT 1`,
      [req.body.nas_id, req.orgId],
    );
    if (!nasRows[0]) throw unknownNasError();

    const record = await recordEvent(nasRows[0], req.body);
    return res.status(201).json({ data: record });
  } catch (err) {
    next(err);
  }
});

// GET /pppoe/events — list event logs with filters
router.get('/events', requirePermission('pppoe.diagnostics'), async (req, res, next) => {
  try {
    const {
      from, to, username, mac, stage, severity,
      page = 1, limit = 50,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (pageNum - 1) * limitNum;

    let sql = `
      SELECT * FROM pppoe_event_logs
      WHERE organization_id = ?
    `;
    const params = [req.orgId];

    if (from) { sql += ' AND logged_at >= ?'; params.push(from); }
    if (to) { sql += ' AND logged_at <= ?'; params.push(to); }
    if (username) { sql += ' AND username = ?'; params.push(username); }
    if (mac) { sql += ' AND mac = ?'; params.push(mac); }
    if (stage) { sql += ' AND stage = ?'; params.push(stage); }
    if (severity) { sql += ' AND severity = ?'; params.push(severity); }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const [countRows] = await db.query(countSql, params);
    const total = countRows[0].total;

    sql += ` ORDER BY logged_at DESC LIMIT ${limitNum} OFFSET ${offset}`;
    const [rows] = await db.query(sql, params);

    res.json({
      data: rows,
      meta: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /pppoe/diagnostics/auth-failures
router.get('/diagnostics/auth-failures', requirePermission('pppoe.diagnostics'), async (req, res, next) => {
  try {
    const { from, to, username } = req.query;
    const result = await pppoeDiagnosticsService.classifyAuthFailures(
      req.orgId,
      from || null,
      to || null,
      username || null,
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /pppoe/diagnostics/mtu-issues
router.get('/diagnostics/mtu-issues', requirePermission('pppoe.diagnostics'), async (req, res, next) => {
  try {
    const result = await pppoeDiagnosticsService.detectMtuIssues(req.orgId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /pppoe/diagnostics/readiness — telemetry source health for the UI banner
router.get('/diagnostics/readiness', requirePermission('pppoe.diagnostics'), async (req, res, next) => {
  try {
    res.json({ data: await pppoeReadinessService.getReadiness(req.orgId) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
