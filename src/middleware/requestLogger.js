// =============================================================================
// VigaBSS 5.0 — HTTP Request Logging Middleware
// =============================================================================
// Logs every request/response with method, url, status, and response time.
// =============================================================================

const logger = require('../utils/logger');

// Query parameters that are masked in log output to prevent leaking secrets
// and personal data (PII) into access logs. The `[?&]NAME=` anchoring means
// each name matches only a whole parameter (never a substring), so listing
// `token` cannot partial-match `access_token` — add exact names as needed.
// extensions/authorization: the GraphQL subscription client used to put the
// staff JWT in the URL as extensions={"authorization":"Bearer …"} (FE-12).
const SENSITIVE_PARAMS = /[?&](password|token|api_key|secret|access_token|refresh_token|username|email|phone|ip_address|source_ip|destination_ip|translated_source_ip|nat_ip|mac|session_id|acct_session_id|extensions|authorization)=[^&]*/gi;
// A bearer token anywhere in a URL, raw or percent-encoded ("Bearer%20…").
const BEARER_IN_URL = /Bearer(?:%20|\+|\s)+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Mask sensitive query parameters in a URL.
 */
function maskUrl(url) {
  return url
    .replace(SENSITIVE_PARAMS, (match) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + '[REDACTED]';
    })
    .replace(BEARER_IN_URL, 'Bearer [REDACTED]');
}

/**
 * Express middleware that logs each request on completion.
 */
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
      : res.statusCode >= 400 ? 'warn'
        : 'info';

    const safeUrl = maskUrl(req.originalUrl);

    logger[level]({
      requestId: req.id || null,
      method: req.method,
      url: safeUrl,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      user_id: req.user?.id || null,
    }, `${req.method} ${safeUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

module.exports = { requestLogger, maskUrl };
