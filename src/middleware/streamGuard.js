// =============================================================================
// VigaBSS 5.0 — long-lived stream guard (GQL-06, SEC-09)
// =============================================================================
// A streaming response (SSE on /events, GraphQL subscriptions over
// text/event-stream) outlives the request that authenticated it. GraphQL
// streams bypassed the SSE limiter, had no concurrency cap and never ended:
// yoga pings every 12 s, so nginx's read timeout never fired, and token
// expiry, logout, password change and deactivation were never re-checked.
//
// streamGuard admits a stream only while its principal (API token, else user)
// and its organization are under their concurrent-stream caps, ends it when
// the access token expires, and re-checks the account every minute
// (realtimeAccess.stillAuthorized). Counts are per process.
// =============================================================================

const config = require('../config');
const logger = require('../utils/logger').child({ service: 'streamGuard' });
const realtimeAccess = require('../services/realtimeAccess');

const MAX_TIMEOUT_MS = 2147483647;
const open = new Map();

function bump(key, delta) {
  const n = (open.get(key) || 0) + delta;
  if (n <= 0) open.delete(key); else open.set(key, n);
}

function isEventStream(req) {
  return String(req.headers?.accept || '').includes('text/event-stream');
}

/**
 * @param {object} [opts]
 * @param {(req) => boolean} [opts.when] only guard requests it returns true for
 */
function streamGuard({ when = () => true } = {}) {
  return function guardStream(req, res, next) {
    if (!when(req) || !req.user) return next();
    const limits = config.rateLimit;
    const principalKey = req.user.apiTokenId
      ? `token:${req.user.apiTokenId}`
      : `user:${req.user.id}`;
    const orgKey = `org:${req.orgId ?? 'none'}`;
    if ((open.get(principalKey) || 0) >= limits.streamsPerPrincipal
        || (open.get(orgKey) || 0) >= limits.streamsPerOrg) {
      return res.status(429).json({ error: { code: 'TOO_MANY_STREAMS', message: 'Too many open real-time streams' } });
    }
    bump(principalKey, 1);
    bump(orgKey, 1);

    const end = () => { try { res.end(); } catch (_err) { /* already closed */ } };
    const expiresAt = req.authSession?.expiresAt;
    const expiry = Number.isFinite(expiresAt)
      ? setTimeout(end, Math.max(0, Math.min(expiresAt - Date.now(), MAX_TIMEOUT_MS)))
      : null;
    const principal = {
      userId: req.user.id,
      tokenVersion: req.authSession?.tokenVersion,
      apiTokenId: req.user.apiTokenId || null,
    };
    const revalidate = setInterval(() => {
      realtimeAccess.stillAuthorized(principal)
        .then(ok => { if (!ok) end(); })
        .catch(err => logger.warn({ err: err.message }, 'stream revalidation failed'));
    }, realtimeAccess.REVALIDATE_MS);
    if (revalidate.unref) revalidate.unref();
    if (expiry && expiry.unref) expiry.unref();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(revalidate);
      if (expiry) clearTimeout(expiry);
      bump(principalKey, -1);
      bump(orgKey, -1);
    };
    res.on('close', release);
    res.on('finish', release);
    return next();
  };
}

module.exports = { streamGuard, isEventStream, _open: open };
