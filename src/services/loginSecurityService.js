// =============================================================================
// VigaBSS 5.0 — Sign-in auditing and blocked IPs (migration 013)
// =============================================================================
// Every sign-in, staff or portal, is written to the audit log with its own
// action, the IP and the browser, so staff can filter them:
//
//   login_success          a staff sign-in (password, or password + 2FA)
//   login_failed           wrong password, unknown/inactive/locked account
//                          (new_values.reason); the user never learns which
//   login_mfa_failed       a wrong 2FA code
//   account_locked         this failure locked the account
//   portal_login_success   a customer portal sign-in
//   portal_login_failed    likewise, for the portal
//   portal_account_locked  likewise
//   login_ip_auto_blocked  an IP was blocked for too many failures
//   login_ip_blocked       staff blocked an IP by hand
//   login_ip_unblocked     staff lifted a block
//
// A failure for an account the install knows is filed under that account's
// organization; one for an email nobody has goes to the install scope
// (organization_id NULL, audit page ?scope=install).
//
// Repeat offenders: every failed sign-in counts against its IP in a fixed
// window (cacheService, Redis when configured). At LOGIN_IP_BLOCK_THRESHOLD
// failures the IP is blocked for LOGIN_IP_BLOCK_HOURS; an IP blocked before
// in the last 30 days gets 7 days, then 30. A blocked IP is refused at every
// sign-in route (middleware/loginIpGuard.js) before any password work, and
// each refusal only bumps a counter on the block row (no audit flood). The
// cost is one counter increment per failure and one indexed lookup per
// sign-in request. Private, loopback, link-local and CGNAT addresses are
// never blocked on their own (an office NAT, the server itself, an ISP's own
// subscribers), nor the LOGIN_IP_BLOCK_EXEMPT list.
// =============================================================================

const net = require('net');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger').child({ service: 'loginSecurity' });
const auditLog = require('./auditLog');
const cache = require('./cacheService');

const REPEAT_LOOKBACK_DAYS = 30;
const ESCALATION_HOURS = [null, 7 * 24, 30 * 24]; // 2nd and 3rd+ block (1st = config hours)
const CACHE_MS = 15 * 1000;
const UA_MAX = 255;

const settings = () => config.loginIpBlock || { enabled: true, threshold: 20, windowMinutes: 60, hours: 24, exempt: [] };

/** The client IP of a request, without the IPv4-mapped IPv6 prefix. */
function clientIp(req) {
  const raw = String((req && (req.ip || req.socket?.remoteAddress)) || '').trim();
  return raw.startsWith('::ffff:') && net.isIPv4(raw.slice(7)) ? raw.slice(7) : raw;
}

/** The sign-in context the routes pass down: { ip, userAgent }. */
function requestContext(req) {
  const ua = req && typeof req.get === 'function' ? req.get('user-agent') : null;
  return { ip: clientIp(req) || null, userAgent: ua ? String(ua).slice(0, UA_MAX) : null };
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0);
}
const V4_PRIVATE = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

/** Private, loopback, link-local, CGNAT, unique-local: never blocked automatically. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const size = 2 ** (32 - bits);
      return n >= base && n < base + size;
    });
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
  }
  return true; // not an IP at all: never block it
}

function isExempt(ip) {
  return !ip || isPrivateAddress(ip) || settings().exempt.includes(ip);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Write one sign-in event. Never throws: auditing must not change the
 * answer the person signing in gets.
 */
async function record({
  action, organizationId = null, userId = null, entityType = 'users', entityId = null, email = null, ctx = {}, extra = {},
}) {
  try {
    const values = {
      ip: ctx.ip || null,
      user_agent: ctx.userAgent || null,
      ...(email ? { email: String(email).trim().toLowerCase().slice(0, 254) } : {}),
      ...extra,
    };
    const who = email ? String(email).trim().toLowerCase() : (entityId ? `#${entityId}` : '');
    await db.withPrimaryContext(() => auditLog.log({
      userId,
      organizationId,
      action,
      entityType,
      entityId,
      summary: `${action}${who ? ` ${who}` : ''}${ctx.ip ? ` from ${ctx.ip}` : ''}`.slice(0, 255),
      newValues: values,
      ipAddress: ctx.ip || null,
      userAgent: ctx.userAgent || null,
    }));
  } catch (err) {
    logger.warn({ err: err.message, action }, 'Sign-in audit failed');
  }
}

// ---------------------------------------------------------------------------
// Blocked IPs
// ---------------------------------------------------------------------------

const blockCache = new Map(); // ip -> { until: ms|null|false, at: ms }

function primary(fn) {
  return db.withPrimaryContext(fn);
}

/** The active block of an IP, or null. Cached for a few seconds. */
async function activeBlock(ip) {
  if (!ip) return null;
  const hit = blockCache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
  const [rows] = await primary(() => db.query(
    `SELECT id, ip_address, source, blocked_until FROM login_ip_blocks
      WHERE ip_address = ? AND lifted_at IS NULL AND (blocked_until IS NULL OR blocked_until > UTC_TIMESTAMP())
      ORDER BY id DESC LIMIT 1`,
    [ip],
  ));
  const row = rows && rows[0] ? rows[0] : null;
  blockCache.set(ip, { row, at: Date.now() });
  return row;
}

/** Count a refused attempt on the block (no audit entry: a blocked bot would flood it). */
async function noteRefused(block) {
  try {
    await primary(() => db.query('UPDATE login_ip_blocks SET refused_count = refused_count + 1 WHERE id = ?', [block.id]));
  } catch (err) {
    logger.warn({ err: err.message, blockId: block.id }, 'Could not count a refused sign-in');
  }
}

/** Hours for a new automatic block of this IP: longer each time it returns. */
async function autoBlockHours(ip) {
  const [[row]] = await primary(() => db.query(
    `SELECT COUNT(*) AS n FROM login_ip_blocks
      WHERE ip_address = ? AND created_at >= (UTC_TIMESTAMP() - INTERVAL ${REPEAT_LOOKBACK_DAYS} DAY)`,
    [ip],
  ));
  const previous = Number(row && row.n) || 0;
  if (previous <= 0) return settings().hours;
  return ESCALATION_HOURS[Math.min(previous, ESCALATION_HOURS.length - 1)];
}

/**
 * Block an IP. `hours` null blocks until lifted (manual only).
 * @returns {Promise<object>} the block row
 */
async function blockIp({ ip, source, hours, failures = 0, note = null, createdBy = null }) {
  const id = await primary(async () => {
    const [res] = await db.query(
      `INSERT INTO login_ip_blocks (ip_address, source, failures, blocked_until, note, created_by)
       VALUES (?, ?, ?, ${hours ? 'UTC_TIMESTAMP() + INTERVAL ? HOUR' : 'NULL'}, ?, ?)`,
      hours ? [ip, source, failures, hours, note, createdBy] : [ip, source, failures, note, createdBy],
    );
    return Number(res.insertId);
  });
  blockCache.delete(ip);
  const [[row]] = await primary(() => db.query('SELECT * FROM login_ip_blocks WHERE id = ?', [id]));
  return row;
}

/**
 * A failed sign-in from `ip`: count it, and block the IP at the threshold.
 * Never throws.
 */
async function noteFailure(ip) {
  const s = settings();
  if (!s.enabled || isExempt(ip)) return null;
  try {
    const { count } = await cache.incrementFixedWindow(`login_fail_ip:${ip}`, s.windowMinutes * 60 * 1000);
    if (count < s.threshold) return null;
    if (await activeBlock(ip)) return null;
    const hours = await autoBlockHours(ip);
    const block = await blockIp({
      ip, source: 'auto', hours, failures: count,
      note: `${count} failed sign-ins in ${s.windowMinutes} min`,
    });
    logger.warn({ ip, hours, failures: count }, 'IP blocked at sign-in after repeated failures');
    await record({
      action: 'login_ip_auto_blocked',
      entityType: 'login_ip_blocks',
      entityId: Number(block.id),
      ctx: { ip },
      extra: { hours, failures: count, blocked_until: block.blocked_until },
    });
    return block;
  } catch (err) {
    logger.warn({ err: err.message, ip }, 'Counting a failed sign-in failed');
    return null;
  }
}

/** Staff lift a block. */
async function liftBlock(id, userId) {
  const [res] = await primary(() => db.query(
    'UPDATE login_ip_blocks SET lifted_at = UTC_TIMESTAMP(), lifted_by = ? WHERE id = ? AND lifted_at IS NULL',
    [userId, id],
  ));
  const [[row]] = await primary(() => db.query('SELECT * FROM login_ip_blocks WHERE id = ?', [id]));
  if (row) blockCache.delete(row.ip_address);
  return { lifted: Boolean(res && res.affectedRows), row: row || null };
}

/** Blocks for the admin list: active first, then the most recent. */
async function listBlocks({ limit = 50, offset = 0, activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE lifted_at IS NULL AND (blocked_until IS NULL OR blocked_until > UTC_TIMESTAMP())' : '';
  const [rows] = await primary(() => db.query(
    `SELECT *, (lifted_at IS NULL AND (blocked_until IS NULL OR blocked_until > UTC_TIMESTAMP())) AS active
       FROM login_ip_blocks ${where}
      ORDER BY active DESC, created_at DESC, id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
  ));
  const [[count]] = await primary(() => db.query(`SELECT COUNT(*) AS total FROM login_ip_blocks ${where}`));
  return { rows: (rows || []).map((r) => ({ ...r, active: Boolean(Number(r.active)) })), total: Number(count && count.total) || 0 };
}

module.exports = {
  clientIp,
  requestContext,
  isPrivateAddress,
  isExempt,
  record,
  activeBlock,
  noteRefused,
  noteFailure,
  blockIp,
  liftBlock,
  listBlocks,
  _blockCache: blockCache,
};
