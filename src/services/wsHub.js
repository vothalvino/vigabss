// =============================================================================
// VigaBSS 5.0 — WebSocket Hub
// =============================================================================
// Real-time push hub for browser clients. It lives below the existing
// /ws/firerelay reverse-proxy tunnel so upgrades work on every installed Nginx
// configuration, including host-Nginx copies that predate the browser hub.
// The FireRelay agent itself still uses the distinct exact path /ws/firerelay.
//
// Protocol (all messages are JSON):
//
//   Client → Server (auth, must arrive within AUTH_TIMEOUT_MS):
//     { "type": "auth", "token": "<access JWT>" }
//     { "type": "auth" }  // browser only: exact-path httpOnly cookie + Origin
//
//   Server → Client (auth result):
//     { "type": "auth_ok", "orgId": N }
//     { "type": "auth_fail", "reason": "..." }
//
//   Client → Server (channel management, after auth):
//     { "type": "subscribe",   "channel": "notifications" }
//     { "type": "unsubscribe", "channel": "notifications" }
//
//     Valid channel names: "notifications" | "metrics" | "outages" |
//                          "ticket:<positive integer>"
//
//   Server → Client (push event):
//     { "type": "event", "event": "<name>", "data": {...}, "channel": "<full>" }
//
//   Server → Client (heartbeat):
//     WebSocket native ping/pong frames (client must respond with pong)
//
// Notes:
//   - Auth uses the short-lived (15 m) JWT access token only — no DB lookup —
//     which keeps the hot path dependency-free.  Compromised/suspended users
//     are naturally evicted when their token expires.
//   - Each authenticated client is scoped to a single organization; cross-org
//     channel subscription attempts are rejected.
// =============================================================================

const { WebSocketServer, WebSocket } = require('ws');
const { verifyStaffAccessToken } = require('../utils/accessTokens');
const logger = require('../utils/logger').child({ service: 'wsHub' });
const { rejectOversizedPreAuth, PendingSockets } = require('./wsLimits');
const realtimeAccess = require('./realtimeAccess');
const { tokenVersionStale } = require('./sessionRevocation');
const { registerWebSocketRoute } = require('./websocketUpgradeRouter');
const {
  BROWSER_WS_PATH,
  BROWSER_WS_COOKIE,
  readCookie,
  isAllowedCookieOrigin,
} = require('./browserWebSocketAuth');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Browser hub frames are small JSON control messages (auth, subscribe).
const MAX_PAYLOAD_BYTES = 16 * 1024;
const AUTH_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 30000;
const PONG_WAIT_MS = 10000;
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Channel names that a client is allowed to subscribe to (relative names). */
const SIMPLE_CHANNELS = new Set(['notifications', 'metrics', 'outages']);
const TICKET_CHANNEL_RE = /^ticket:(\d+)$/;

// ---------------------------------------------------------------------------
// WsHub
// ---------------------------------------------------------------------------

class WsHub {
  constructor() {
    /** @type {WebSocketServer|null} */
    this._wss = null;
    /** @type {(() => void)|null} */
    this._unregisterUpgradeRoute = null;

    /**
     * channel (full, e.g. "org:1:notifications") → Set<WebSocket>
     * @type {Map<string, Set<WebSocket>>}
     */
    this._channels = new Map();

    /** ws → Set<string channels> */
    this._clientChannels = new Map();

    /** ws → NodeJS.Timeout (ping interval) */
    this._pingTimers = new Map();

    /** ws → NodeJS.Timeout (JWT expiry deadline) */
    this._expiryTimers = new Map();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Attach the hub to an existing HTTP server.
   * @param {import('http').Server} httpServer
   */
  attach(httpServer) {
    if (this._wss) {
      throw new Error('WsHub already attached');
    }

    // Use the shared exact-path dispatcher rather than
    // WebSocketServer({ server, path }). The latter installs a catch-all
    // `upgrade` listener that sends HTTP 400 for a path mismatch; with both the
    // FireRelay agent tunnel and browser hub on one server, whichever listener
    // ran first rejected the other's path.
    this._wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this._pendingSockets = new PendingSockets();
    const wss = this._wss;
    this._unregisterUpgradeRoute = registerWebSocketRoute(
      httpServer,
      BROWSER_WS_PATH,
      (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      }),
    );

    this._wss.on('connection', (ws, req) => {
      const remoteIp = req.socket.remoteAddress;
      logger.debug({ remoteIp }, 'WsHub: new connection');
      this._handleConnection(ws, req);
    });

    this._wss.on('error', (err) => {
      logger.error({ err }, 'WsHub: server error');
    });

    logger.info(`WsHub attached at ${BROWSER_WS_PATH}`);
  }

  /**
   * Close all client connections and shut down the WebSocket server.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => {
      this._unregisterUpgradeRoute?.();
      this._unregisterUpgradeRoute = null;

      // Stop all ping timers
      for (const [ws, timer] of this._pingTimers) {
        clearInterval(timer);
        ws.terminate();
      }
      this._pingTimers.clear();
      for (const timer of this._expiryTimers.values()) {
        clearTimeout(timer);
      }
      this._expiryTimers.clear();
      this._channels.clear();
      this._clientChannels.clear();

      if (this._wss) {
        this._wss.close(() => {
          this._wss = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── Broadcasting ───────────────────────────────────────────────────────────

  /**
   * Send an event to all WebSocket clients subscribed to a channel.
   * @param {string} channel - Full channel name, e.g. "org:1:notifications"
   * @param {string} event   - Event name, e.g. "notification"
   * @param {object} data    - Payload (serialised to JSON)
   */
  broadcastWs(channel, event, data) {
    const clients = this._channels.get(channel);
    if (!clients || clients.size === 0) return;

    const message = JSON.stringify({ type: 'event', event, data, channel });
    const filtered = channel.endsWith(':notifications');
    for (const ws of clients) {
      if (filtered && !(ws._grants && realtimeAccess.mayReceive(ws._grants, event, data))) continue;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          logger.warn({ err: err.message }, 'WsHub: send error, removing client');
          this._removeClient(ws);
        }
      } else {
        this._removeClient(ws);
      }
    }
  }

  // ── Connection Handling ────────────────────────────────────────────────────

  _handleConnection(ws, req) {
    ws._authenticated = false;
    // Cap the unauthenticated sockets one IP (and the server) may hold (SEC-16).
    const releasePending = (this._pendingSockets || new PendingSockets()).admit(req.socket.remoteAddress);
    if (!releasePending) {
      ws.close(1013, 'Too many pending connections');
      return;
    }
    ws._releasePending = releasePending;
    ws._orgId = null;
    // Keep the ambient credential only until the first auth attempt, and only
    // when a real browser supplied an explicitly allowed Origin.
    ws._cookieAccessToken = isAllowedCookieOrigin(req)
      ? readCookie(req.headers.cookie, BROWSER_WS_COOKIE)
      : null;

    // Require auth within AUTH_TIMEOUT_MS
    const authTimer = setTimeout(() => {
      if (!ws._authenticated) {
        logger.warn('WsHub: auth timeout, closing connection');
        ws.close(4001, 'Authentication timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      // An auth message is a few hundred bytes; parse nothing larger before auth.
      if (!ws._authenticated && rejectOversizedPreAuth(ws, raw)) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_e) {
        ws.send(JSON.stringify({ type: 'error', reason: 'Invalid JSON' }));
        return;
      }

      if (ws._authPending) return;
      if (!ws._authenticated) {
        ws._authPending = true;
        this._handleAuth(ws, msg, authTimer)
          .catch((err) => {
            logger.warn({ err: err.message }, 'WsHub: auth failed');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Authentication failed' }));
              ws.close(4003, 'Invalid token');
            }
          })
          .finally(() => { ws._authPending = false; });
      } else {
        this._handleClientMessage(ws, msg);
      }
    });

    ws.on('pong', () => {
      ws._lastPong = Date.now();
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      releasePending();
      this._removeClient(ws);
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'WsHub: client error');
    });
  }

  async _handleAuth(ws, msg, authTimer) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'auth' ||
        (msg.token !== undefined && typeof msg.token !== 'string')) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Expected an authentication message' }));
      ws.close(4002, 'Auth protocol error');
      return;
    }

    // Explicit credentials take precedence. Browser clients restored through
    // AuthContext's cookie-first path send no token and use the narrow httpOnly
    // cookie captured during the same-origin upgrade instead.
    const token = typeof msg.token === 'string' ? msg.token : ws._cookieAccessToken;
    ws._cookieAccessToken = null;
    if (!token) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Missing authentication credential' }));
      ws.close(4003, 'Invalid token');
      return;
    }

    let payload;
    try {
      // Staff hub only: subscriber-portal tokens must not join the org feed.
      payload = verifyStaffAccessToken(token);
    } catch (_err) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Invalid or expired token' }));
      ws.close(4003, 'Invalid token');
      return;
    }

    const orgId = payload.orgId;
    if (!orgId) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Token missing orgId claim' }));
      ws.close(4004, 'Missing orgId');
      return;
    }

    // Access JWTs are deliberately short lived. Require the expiry claim and
    // evict the socket at that exact deadline; verification at connection time
    // alone would otherwise leave a compromised socket authenticated forever.
    const expiresAt = Number(payload.exp) * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Invalid or expired token' }));
      ws.close(4003, 'Invalid token');
      return;
    }

    // The JWT alone is not enough (SEC-09): resolve the account as
    // authenticate() does — active, current token version (SEC-10), still a
    // member of the organization — and the event slugs it holds.
    const User = require('../models/User');
    const { resolveOrgPrincipal } = require('./orgPrincipalService');
    const user = await User.findById(payload.sub);
    const principal = user && user.status === 'active' && !tokenVersionStale(payload.tv, user.token_version)
      ? await resolveOrgPrincipal(user, orgId)
      : null;
    if (!principal) {
      ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Invalid or expired token' }));
      ws.close(4003, 'Invalid token');
      return;
    }
    ws._req = {
      orgId,
      user: {
        id: user.id,
        role: principal.authorizationRole,
        membershipRole: principal.membershipRole,
        organizationId: principal.organizationId,
        isInstallOperator: principal.isInstallOperator,
        isSuperAdmin: principal.isSuperAdmin,
        hasGlobalOrganizationAccess: principal.hasGlobalOrganizationAccess,
      },
    };
    ws._grants = await realtimeAccess.resolveGrants(ws._req);
    ws._principal = { userId: user.id, tokenVersion: payload.tv };
    if (ws.readyState !== WebSocket.OPEN) return;

    clearTimeout(authTimer);
    ws._authenticated = true;
    if (ws._releasePending) ws._releasePending();
    ws._orgId = orgId;
    ws._lastPong = Date.now();

    this._clientChannels.set(ws, new Set());

    ws.send(JSON.stringify({ type: 'auth_ok', orgId }));
    logger.debug({ orgId }, 'WsHub: client authenticated');

    // Start heartbeat
    const pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(pingTimer);
        this._pingTimers.delete(ws);
        return;
      }
      const now = Date.now();
      if (ws._lastPong && now - ws._lastPong > PING_INTERVAL_MS + PONG_WAIT_MS) {
        logger.warn({ orgId }, 'WsHub: pong timeout, terminating client');
        ws.terminate();
        clearInterval(pingTimer);
        this._pingTimers.delete(ws);
        return;
      }
      ws.ping();
    }, PING_INTERVAL_MS);

    this._pingTimers.set(ws, pingTimer);
    this._scheduleExpiry(ws, expiresAt);

    // Re-check the account while the socket stays open (SEC-09).
    const revalidate = setInterval(() => {
      realtimeAccess.stillAuthorized(ws._principal)
        .then((ok) => { if (!ok && ws.readyState === WebSocket.OPEN) ws.close(4006, 'Session revoked'); })
        .catch(err => logger.warn({ err: err.message }, 'WsHub: revalidation failed'));
    }, realtimeAccess.REVALIDATE_MS);
    if (revalidate.unref) revalidate.unref();
    ws._revalidateTimer = revalidate;
  }

  /**
   * Close an authenticated socket when its access JWT expires. Re-arm long
   * deadlines because Node clamps setTimeout values above a signed 32-bit int.
   */
  _scheduleExpiry(ws, expiresAt) {
    const arm = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        this._expiryTimers.delete(ws);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(4005, 'Access token expired');
        }
        return;
      }

      const timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS));
      this._expiryTimers.set(ws, timer);
    };

    arm();
  }

  _handleClientMessage(ws, msg) {
    if (msg.type === 'subscribe') {
      this._subscribe(ws, msg.channel)
        .catch(err => logger.warn({ err: err.message }, 'WsHub: subscribe failed'));
    } else if (msg.type === 'unsubscribe') {
      this._unsubscribe(ws, msg.channel);
    } else {
      ws.send(JSON.stringify({ type: 'error', reason: `Unknown message type: ${msg.type}` }));
    }
  }

  /**
   * Subscribe an authenticated client to a channel.
   * @param {WebSocket} ws
   * @param {string} relativeChannel - e.g. "notifications", "ticket:42"
   */
  async _subscribe(ws, relativeChannel) {
    const full = this._resolveChannel(ws._orgId, relativeChannel);
    if (!full) {
      ws.send(JSON.stringify({ type: 'error', reason: `Invalid channel: ${relativeChannel}` }));
      return;
    }
    // Each channel needs its REST counterpart's slug, and a ticket channel the
    // ticket itself (in the organization; billing needs view_billing) — SEC-09.
    const ticket = TICKET_CHANNEL_RE.exec(relativeChannel);
    const kind = ticket ? 'ticket' : relativeChannel;
    let allowed = await realtimeAccess.mayJoinChannel(ws._req, kind);
    if (allowed && ticket) {
      const db = require('../config/database');
      const { userHasPermission } = require('../middleware/rbac');
      const [[row]] = await db.query(
        'SELECT id, category FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [Number(ticket[1]), ws._orgId],
      );
      allowed = Boolean(row) && (row.category !== 'billing' || await userHasPermission(ws._req, 'tickets.view_billing'));
    }
    if (!allowed) {
      ws.send(JSON.stringify({ type: 'error', reason: `Not permitted: ${relativeChannel}` }));
      return;
    }
    if (ws.readyState !== WebSocket.OPEN || !this._clientChannels.has(ws)) return;

    if (!this._channels.has(full)) {
      this._channels.set(full, new Set());
    }
    this._channels.get(full).add(ws);
    this._clientChannels.get(ws).add(full);

    ws.send(JSON.stringify({ type: 'subscribed', channel: full }));
    logger.debug({ orgId: ws._orgId, channel: full }, 'WsHub: subscribed');
  }

  /**
   * Unsubscribe a client from a channel.
   */
  _unsubscribe(ws, relativeChannel) {
    const full = this._resolveChannel(ws._orgId, relativeChannel);
    if (!full) {
      ws.send(JSON.stringify({ type: 'error', reason: `Invalid channel: ${relativeChannel}` }));
      return;
    }

    const channelClients = this._channels.get(full);
    if (channelClients) {
      channelClients.delete(ws);
      if (channelClients.size === 0) this._channels.delete(full);
    }
    const clientSubs = this._clientChannels.get(ws);
    if (clientSubs) clientSubs.delete(full);

    ws.send(JSON.stringify({ type: 'unsubscribed', channel: full }));
  }

  /**
   * Remove a client from all channels and clean up timers.
   */
  _removeClient(ws) {
    const timer = this._pingTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      this._pingTimers.delete(ws);
    }

    const expiryTimer = this._expiryTimers.get(ws);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      this._expiryTimers.delete(ws);
    }

    ws._cookieAccessToken = null;
    if (ws._revalidateTimer) {
      clearInterval(ws._revalidateTimer);
      ws._revalidateTimer = null;
    }

    const subs = this._clientChannels.get(ws);
    if (subs) {
      for (const ch of subs) {
        const set = this._channels.get(ch);
        if (set) {
          set.delete(ws);
          if (set.size === 0) this._channels.delete(ch);
        }
      }
      this._clientChannels.delete(ws);
    }
  }

  /**
   * Resolve a relative channel name to a full org-scoped channel name.
   * Returns null if the channel name is not valid.
   * @param {number|string} orgId
   * @param {string} relative
   * @returns {string|null}
   */
  _resolveChannel(orgId, relative) {
    if (typeof relative !== 'string') return null;

    if (SIMPLE_CHANNELS.has(relative)) {
      return `org:${orgId}:${relative}`;
    }

    const m = relative.match(TICKET_CHANNEL_RE);
    if (m) {
      const ticketId = parseInt(m[1], 10);
      if (ticketId > 0) {
        return `org:${orgId}:ticket:${ticketId}`;
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const wsHub = new WsHub();

module.exports = { WsHub, wsHub, BROWSER_WS_PATH };
