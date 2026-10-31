// =============================================================================
// VigaBSS 5.0 — Real-Time Events (SSE)
// =============================================================================
// Server-Sent Events (SSE) implementation for real-time push notifications.
// Uses SSE instead of WebSocket to avoid additional dependencies (Socket.io)
// and to work through HTTP/2 proxies and load balancers without extra config.
//
// Channels:
//   /api/events/stream         — Authenticated user's notification feed
//   /api/events/metrics        — Live SNMP metrics for dashboard (admin)
//   /api/events/tickets/:id    — Ticket comment/status updates
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const db = require('../config/database');
const { userHasPermission } = require('../middleware/rbac');
const realtimeAccess = require('../services/realtimeAccess');
const logger = require('../utils/logger');
// Lazy-required to avoid circular-module issues at startup
let _wsHub;
function getWsHub() {
  if (!_wsHub) _wsHub = require('../services/wsHub').wsHub;
  return _wsHub;
}

const router = Router();

// ---------------------------------------------------------------------------
// SSE Client Registry
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<import('http').ServerResponse>>} */
const channels = new Map();

/**
 * Get or create a channel's client set.
 */
function getChannel(name) {
  if (!channels.has(name)) {
    channels.set(name, new Set());
  }
  return channels.get(name);
}

/**
 * Broadcast an event to all clients subscribed to a channel.
 * @param {string} channel - Channel name (e.g. 'org:1:notifications')
 * @param {string} event   - SSE event name
 * @param {object} data    - Payload (serialized to JSON)
 */
function broadcast(channel, event, data) {
  const clients = channels.get(channel);
  if (clients && clients.size > 0) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      // Notification-feed events go only to subscribers holding the event's
      // slug (SEC-09); other channels were permission-checked at join.
      if (res._grants && !realtimeAccess.mayReceive(res._grants, event, data)) continue;
      try {
        res.write(message);
      } catch (_err) {
        clients.delete(res);
      }
    }
  }

  // Also push to WebSocket clients on the same channel
  try {
    getWsHub().broadcastWs(channel, event, data);
  } catch (_err) {
    // wsHub may not be attached in test environments — ignore
  }
}

/**
 * Send an event to a specific SSE response.
 */
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Setup SSE headers and keepalive.
 */
function initSseResponse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });
  res.write(':ok\n\n'); // Initial comment to establish connection
}

/**
 * Start a keepalive timer and register cleanup on client disconnect.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} channel
 * @param {Set} clients
 */
function registerSseClient(req, res, channel, clients) {
  clients.add(res);

  const keepalive = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch (_err) {
      clearInterval(keepalive);
    }
  }, 30000);

  // A stream outlives the request that opened it: end it when the access
  // token expires, and re-check the account so a deactivated, archived or
  // revoked (token version) principal loses it (SEC-09).
  const principal = {
    userId: req.user.id,
    tokenVersion: req.authSession?.tokenVersion,
    apiTokenId: req.user.apiTokenId || null,
  };
  const end = () => { try { res.end(); } catch (_err) { /* already closed */ } };
  const expiresAt = req.authSession?.expiresAt;
  const expiry = Number.isFinite(expiresAt)
    ? setTimeout(end, Math.max(0, Math.min(expiresAt - Date.now(), 2147483647)))
    : null;
  const revalidate = setInterval(() => {
    realtimeAccess.stillAuthorized(principal)
      .then(ok => { if (!ok) end(); })
      .catch(err => logger.warn({ err: err.message }, 'SSE revalidation failed'));
  }, realtimeAccess.REVALIDATE_MS);
  if (revalidate.unref) revalidate.unref();
  if (expiry && expiry.unref) expiry.unref();

  req.on('close', () => {
    clearInterval(keepalive);
    clearInterval(revalidate);
    if (expiry) clearTimeout(expiry);
    clients.delete(res);
    if (clients.size === 0) channels.delete(channel);
  });
}

/** 403 unless the caller holds what the channel kind needs. */
function requireChannel(kind) {
  return async (req, res, next) => {
    try {
      if (await realtimeAccess.mayJoinChannel(req, kind)) return next();
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions for this stream' } });
    } catch (err) { return next(err); }
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/events/stream
 * Authenticated SSE stream for the current user's organization notifications.
 */
router.get('/stream', authenticate, orgScope, async (req, res, next) => {
  let grants;
  try {
    grants = await realtimeAccess.resolveGrants(req);
  } catch (err) { return next(err); }
  initSseResponse(res);
  res._grants = grants;

  const channel = `org:${req.orgId}:notifications`;
  const clients = getChannel(channel);

  logger.debug({ channel, userId: req.user.id }, 'SSE client connected');

  // Send initial connection confirmation
  sendEvent(res, 'connected', { channel, timestamp: new Date().toISOString() });

  registerSseClient(req, res, channel, clients);
});

/**
 * GET /api/events/metrics
 * Real-time SNMP metrics stream (admin only).
 * Broadcasts latest poll results as they arrive.
 */
router.get('/metrics', authenticate, orgScope, requireChannel('metrics'), (req, res) => {
  initSseResponse(res);

  const channel = `org:${req.orgId}:metrics`;
  const clients = getChannel(channel);

  sendEvent(res, 'connected', { channel, timestamp: new Date().toISOString() });
  registerSseClient(req, res, channel, clients);
});

/**
 * GET /api/events/tickets/:id
 * Real-time updates for a specific ticket (comments, status changes).
 * The ticket ID is validated as a numeric integer to prevent injection.
 */
router.get('/tickets/:id', authenticate, orgScope, requireChannel('ticket'), async (req, res, next) => {
  // Validate and sanitize the ticket ID (integer only)
  if (!/^[1-9]\d*$/.test(String(req.params.id))) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'Ticket ID must be a positive integer' } });
  }
  const ticketId = Number(req.params.id);

  // The ticket must be this organization's, and a billing ticket needs
  // tickets.view_billing — the same rule as GET /tickets/:id (SEC-09).
  try {
    const [[ticket]] = await db.query(
      'SELECT id, category FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [ticketId, req.orgId],
    );
    if (!ticket || (ticket.category === 'billing' && !(await userHasPermission(req, 'tickets.view_billing')))) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
    }
  } catch (err) { return next(err); }

  initSseResponse(res);

  const channel = `org:${req.orgId}:ticket:${ticketId}`;
  const clients = getChannel(channel);

  sendEvent(res, 'connected', { channel, ticketId, timestamp: new Date().toISOString() });
  registerSseClient(req, res, channel, clients);
});

/**
 * GET /api/events/outages
 * Real-time outage alerts for the organization.
 */
router.get('/outages', authenticate, orgScope, requireChannel('outages'), (req, res) => {
  initSseResponse(res);

  const channel = `org:${req.orgId}:outages`;
  const clients = getChannel(channel);

  sendEvent(res, 'connected', { channel, timestamp: new Date().toISOString() });
  registerSseClient(req, res, channel, clients);
});

// ---------------------------------------------------------------------------
// Stats endpoint (non-SSE)
// ---------------------------------------------------------------------------

/**
 * GET /api/events/stats
 * Returns current SSE connection stats (admin debug).
 */
router.get('/stats', authenticate, orgScope, (req, res) => {
  // Only the caller's organization's channels; the install operator sees all
  // (the map named every tenant's ticket channels, SEC-09).
  const all = Boolean(req.user?.isInstallOperator);
  const prefix = `org:${req.orgId}:`;
  const stats = {};
  let total = 0;
  for (const [name, clients] of channels.entries()) {
    if (!all && !name.startsWith(prefix)) continue;
    stats[name] = clients.size;
    total += clients.size;
  }
  res.json({ channels: stats, totalConnections: total });
});

module.exports = { router, broadcast, sendEvent, getChannel, channels };
