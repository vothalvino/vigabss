// =============================================================================
// VigaBSS 5.0 — Refuse sign-ins from a blocked IP (migration 013)
// =============================================================================
// Mounted on the sign-in routes (staff /auth/login and /auth/login/2fa,
// portal /portal/auth/login) before any password work. A blocked IP gets 429
// LOGIN_IP_BLOCKED with Retry-After; the refusal is counted on the block row,
// not written to the audit log one by one. A database error lets the request
// through: the per-IP rate limit and the account lockout still apply.
// Private and LOGIN_IP_BLOCK_EXEMPT addresses are never looked up.
// =============================================================================

const loginSecurity = require('../services/loginSecurityService');
const logger = require('../utils/logger').child({ middleware: 'loginIpGuard' });

async function loginIpGuard(req, res, next) {
  const ip = loginSecurity.clientIp(req);
  // A private or exempt address is never blocked (an office NAT, the server
  // itself, a proxy that hides the client): no lookup at all.
  if (loginSecurity.isExempt(ip)) return next();
  let block;
  try {
    block = await loginSecurity.activeBlock(ip);
  } catch (err) {
    logger.warn({ err: err.message }, 'Blocked-IP lookup failed; letting the sign-in through');
    return next();
  }
  if (!block) return next();
  await loginSecurity.noteRefused(block);
  if (block.blocked_until) {
    const seconds = Math.max(1, Math.ceil((new Date(block.blocked_until).getTime() - Date.now()) / 1000));
    res.set('Retry-After', String(seconds));
  }
  return res.status(429).json({
    error: {
      code: 'LOGIN_IP_BLOCKED',
      message: 'Too many failed sign-in attempts from your network. Try again later or contact your provider.',
      ...(req.id ? { requestId: req.id } : {}),
    },
  });
}

module.exports = { loginIpGuard };
