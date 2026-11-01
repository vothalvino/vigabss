// =============================================================================
// VigaBSS 5.0 — Embedded RADIUS Server
// =============================================================================
// A native RADIUS auth (UDP 1812) + accounting (UDP 1813) server so VigaBSS can
// authenticate PPPoE/RADIUS subscribers itself — no external FreeRADIUS daemon
// required. A MikroTik (or any NAS) points its `/radius` at the VigaBSS host and
// VigaBSS answers Access-Requests from its own `radius` table and routes
// accounting through the existing radiusAccountingService.ingestAccounting.
//
// Opt-in via RADIUS_SERVER_ENABLED=true (default off — it binds privileged-ish
// UDP ports and is only useful when VigaBSS is the RADIUS server).
//
// Reuses: radiusServerCodec (decode + PAP/CHAP + signing), radiusCoaEncoder
// (attribute/packet encoding) and radiusAttributeService (plan policy attrs).
// =============================================================================

const dgram = require('dgram');
const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger').child({ service: 'radiusServer' });
const codec = require('./radiusServerCodec');
const coa = require('./radiusCoaEncoder');
const { generateAttributes, generateThrottleAttributes, hasThrottle } = require('./radiusAttributeService');
const speedWindowService = require('./speedWindowService');
const { resolveNasByIp } = require('./tenantNasResolverService');

const { CODE, ATTR, ACCT_STATUS } = codec;

const AUTH_REASON = Object.freeze({
  ACCEPTED: 'accepted',
  MISSING_USERNAME: 'missing_username',
  UNKNOWN_OR_INACTIVE_USER: 'unknown_or_inactive_user',
  PASSWORD_NOT_CONFIGURED: 'password_not_configured',
  UNSUPPORTED_AUTH_METHOD: 'unsupported_auth_method',
  BAD_PASSWORD: 'bad_password',
});

let authSocket = null;
let acctSocket = null;

const counters = {
  authRequests: 0, accepts: 0, rejects: 0, authDropped: 0,
  acctRequests: 0, acctIngested: 0, acctDropped: 0,
  droppedOverload: 0, droppedSourceRate: 0, droppedNoMessageAuth: 0, postAuthSkipped: 0,
};

// ---------------------------------------------------------------------------
// Ingress bounds (NET-20)
// ---------------------------------------------------------------------------
// Every datagram used to start its own async handler, and one from a known NAS
// IP costs a secret fetch, a subscriber query and a radpostauth INSERT. Access-
// Requests without Message-Authenticator cannot be authenticated, so a spoofed-
// source flood from a registered NAS's address saturated the shared MySQL pool
// and the event loop. Same shape as the SNMP trap receiver: a fixed in-flight
// cap and per-source token buckets in a fixed-size table (spoofing cannot grow
// it), with drop counters on /radius/server-status.

const envInt = (name, fallback, min, max) => {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const MAX_IN_FLIGHT = envInt('RADIUS_SERVER_MAX_IN_FLIGHT', 64, 1, 4096);
const SOURCE_RATE_PER_SEC = envInt('RADIUS_SERVER_SOURCE_RATE', 200, 1, 100000);
const SOURCE_BURST = envInt('RADIUS_SERVER_SOURCE_BURST', 400, 1, 200000);
const SOURCE_BUCKETS = 4096;
const sourceBuckets = new Array(SOURCE_BUCKETS).fill(null);
let inFlight = 0;

function bucketIndex(address) {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 16777619);
  return (h >>> 0) % SOURCE_BUCKETS;
}

function takeSourceToken(address, now = Date.now()) {
  const i = bucketIndex(String(address || ''));
  const bucket = sourceBuckets[i] || { tokens: SOURCE_BURST, at: now };
  bucket.tokens = Math.min(SOURCE_BURST, bucket.tokens + ((now - bucket.at) / 1000) * SOURCE_RATE_PER_SEC);
  bucket.at = now;
  sourceBuckets[i] = bucket;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Past half the in-flight cap, optional work (radpostauth rows) is skipped. */
function saturated() {
  return inFlight >= MAX_IN_FLIGHT / 2;
}

function resetIngressBounds() {
  sourceBuckets.fill(null);
  inFlight = 0;
}

// ---------------------------------------------------------------------------
// Data lookups
// ---------------------------------------------------------------------------

/** Resolve the NAS (and its RADIUS shared secret) by source IP. */
async function findNasByIp(ip) {
  if (typeof db.withPrimaryContext === 'function' && typeof db.withTenantContext === 'function') {
    const resolution = await resolveNasByIp(ip, { includeSecret: true });
    return resolution.nas;
  }
  // Minimal test/custom adapters without tenant routing retain the shared-only
  // lookup. Production always resolves every database scope above so a reused
  // private NAS IP fails closed as ambiguous.
  const [rows] = await db.query(
    `SELECT n.id, n.organization_id, n.secret, n.require_message_authenticator
       FROM nas n
      WHERE n.ip_address = ?
        AND n.status = 'active'
        AND n.organization_id IS NOT NULL
        AND n.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM organization_database_configs odc
           WHERE odc.organization_id = n.organization_id
             AND odc.isolation_mode = 'isolated'
        )
      LIMIT 1`,
    [ip],
  );
  return rows[0] || null;
}

function withNasTenant(nas, callback) {
  if (typeof db.withTenantContext === 'function' && nas?.organization_id) {
    return db.withTenantContext(nas.organization_id, callback);
  }
  return callback();
}

/**
 * Resolve a subscriber in the source NAS's organization whose contract may
 * authenticate now. A pending line is accepted only inside its bounded
 * installation test window; checking the timestamp here makes expiry fail
 * closed immediately even if the five-minute cleanup sweep has not yet changed
 * radius.status back to inactive.
 */
async function findSubscriber(username, organizationId) {
  const [rows] = await db.query(
    `SELECT r.id, r.client_id, r.contract_id, r.username, r.password, r.ip_address,
            r.ipv6_address, r.ipv6_delegated_prefix, r.ipv6_prefix_len,
            ipv6_pool.name AS ipv6_pool_name,
            c.plan_id, c.status AS contract_status,
            c.soft_suspend_download_kbps, c.soft_suspend_upload_kbps,
            CASE WHEN c.status = 'pending'
                 THEN GREATEST(TIMESTAMPDIFF(SECOND, NOW(), c.test_window_expires_at), 1)
                 ELSE NULL END AS test_window_seconds_remaining
       FROM radius r
       LEFT JOIN contracts c ON c.id = r.contract_id
       LEFT JOIN ip_pools ipv6_pool ON ipv6_pool.id = r.ipv6_pool_id AND ipv6_pool.deleted_at IS NULL
      WHERE r.username = ? AND r.organization_id <=> ?
        AND r.deleted_at IS NULL AND r.status = 'active'
        AND (
          c.id IS NULL
          OR c.status = 'active'
          OR (c.status = 'pending'
              AND c.test_window_cleanup_pending = 0
              AND c.test_window_expires_at > NOW())
        )
      LIMIT 1`,
    [username, organizationId],
  );
  return rows[0] || null;
}

async function findPlan(planId) {
  if (!planId) return null;
  const [rows] = await db.query('SELECT * FROM plans WHERE id = ? LIMIT 1', [planId]);
  return rows[0] || null;
}

/**
 * Pick the shared secret for a *known* NAS (matched by source IP). The global
 * RADIUS_SERVER_SECRET is only a fallback for a matched NAS row that has no
 * per-NAS secret — it never makes an unknown source IP a valid client (that
 * would defeat the unknown-NAS drop and create an enumeration/reflection oracle).
 */
function secretFor(nas) {
  if (!nas) return null;
  return nas.secret || config.radiusServer.secret || null;
}

/** Constant-time string compare (avoids leaking the stored password via timing). */
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** True only for a clean dotted-quad IPv4 (so we never emit a garbage Framed-IP). */
function isIpv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Persist an authentication outcome without putting the authentication reply
 * on the database write path.  The UDP response is sent before this function is
 * called; synchronous driver errors and asynchronous query failures are both
 * contained here.  In particular, no supplied or stored password is accepted
 * by this function or named in its INSERT.
 */
function persistAuthOutcome({
  nas, username, nasIpAddress, callingStationId, reply, reasonCode,
}) {
  const values = [
    nas.organization_id ?? null,
    nas.id,
    typeof username === 'string' ? username.slice(0, 64) : '',
    reply,
    typeof nasIpAddress === 'string' ? nasIpAddress.slice(0, 45) : null,
    typeof callingStationId === 'string' ? callingStationId.slice(0, 100) : null,
    reasonCode,
  ];

  try {
    const pending = withNasTenant(nas, () => db.query(
      `INSERT INTO radpostauth
         (organization_id, nas_id, username, reply, nas_ip_address,
          calling_station_id, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      values,
    ));
    Promise.resolve(pending).catch((err) => {
      logger.warn(
        { err: err.message, nasId: nas.id, reasonCode },
        'RADIUS: post-auth outcome logging failed',
      );
    });
  } catch (err) {
    logger.warn(
      { err: err.message, nasId: nas.id, reasonCode },
      'RADIUS: post-auth outcome logging failed',
    );
  }
}

// ---------------------------------------------------------------------------
// Reply attribute assembly
// ---------------------------------------------------------------------------

function ipv6AcceptAttributes(subscriber) {
  const out = [];
  if (subscriber.ipv6_address) {
    const attr = codec.encodeIpv6AddressAttr(ATTR.FRAMED_IPV6_ADDRESS, subscriber.ipv6_address);
    if (attr) out.push(attr);
  }
  if (subscriber.ipv6_delegated_prefix) {
    const [address, lenText] = String(subscriber.ipv6_delegated_prefix).split('/');
    const attr = codec.encodeIpv6PrefixAttr(ATTR.DELEGATED_IPV6_PREFIX, address, Number(lenText ?? subscriber.ipv6_prefix_len));
    if (attr) out.push(attr);
  }
  if (subscriber.ipv6_pool_name) {
    const attr = codec.encodeStringAttr(ATTR.DELEGATED_IPV6_PREFIX_POOL, subscriber.ipv6_pool_name);
    if (attr) out.push(attr);
  }
  return out;
}

function buildAcceptAttributes(subscriber, plan, withMessageAuth) {
  const parts = [
    codec.encodeIntAttr(ATTR.SERVICE_TYPE, 2),     // Framed-User
    codec.encodeIntAttr(ATTR.FRAMED_PROTOCOL, 1),  // PPP
  ];
  if (isIpv4(subscriber.ip_address)) {
    parts.push(coa.encodeFramedIPAddress(subscriber.ip_address)); // static Framed-IP (IPv4)
  }
  // IPv6 (NET-17): a dual-stack account's static WAN address, delegated
  // prefix and DHCPv6-PD pool, which the embedded server never sent.
  for (const attr of ipv6AcceptAttributes(subscriber)) parts.push(attr);
  if (subscriber.contract_status === 'pending') {
    const remaining = Math.floor(Number(subscriber.test_window_seconds_remaining));
    if (Number.isSafeInteger(remaining) && remaining > 0) {
      parts.push(codec.encodeIntAttr(ATTR.SESSION_TIMEOUT, remaining));
    }
  }
  if (plan) {
    // A soft-suspended contract (NPR-01) gets its throttle instead of the
    // plan (or speed-window) rate.
    const attrMap = subscriber.contract_status === 'active' && hasThrottle(subscriber)
      ? generateThrottleAttributes(plan.radius_vendor, subscriber.soft_suspend_download_kbps, subscriber.soft_suspend_upload_kbps)
      : generateAttributes(plan);
    const named = [];
    for (const [name, val] of Object.entries(attrMap)) {
      if (Array.isArray(val)) val.forEach((v) => named.push({ name, value: String(v) }));
      else named.push({ name, value: String(val) });
    }
    if (named.length) {
      const policy = coa.encodeNamedAttributes(named);
      if (policy.length === 0) {
        // generateAttributes produced names the encoder can't emit (e.g. Juniper)
        // — surface it loudly rather than silently granting an unshaped session.
        logger.error({ vendor: plan.radius_vendor, plan_id: plan.id },
          'RADIUS: no policy attributes could be encoded for plan — subscriber would be uncapped');
      } else {
        parts.push(policy);
      }
    }
  }
  // Message-Authenticator placeholder (filled by signResponse) when the client used one.
  if (withMessageAuth) parts.unshift(codec.messageAuthenticatorPlaceholder());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Access-Request handling (UDP 1812)
// ---------------------------------------------------------------------------

async function handleAuth(msg, rinfo, respond) {
  counters.authRequests++;
  let pkt;
  try {
    pkt = codec.decodePacket(msg);
  } catch (err) {
    counters.authDropped++;
    logger.warn({ from: rinfo.address, err: err.message }, 'RADIUS: undecodable auth packet — dropped');
    return;
  }
  if (pkt.code !== CODE.ACCESS_REQUEST) { counters.authDropped++; return; }

  const nas = await findNasByIp(rinfo.address);
  const secret = secretFor(nas);
  if (!secret) {
    // Unknown client — RFC 2865 says silently discard.
    counters.authDropped++;
    logger.warn({ from: rinfo.address }, 'RADIUS: Access-Request from unknown NAS (no shared secret) — dropped');
    return;
  }

  // Defend against forged/Blast-RADIUS packets when the client used Message-Authenticator.
  if (!codec.verifyMessageAuthenticator(pkt.raw, pkt.attributes, secret)) {
    counters.authDropped++;
    logger.warn({ from: rinfo.address }, 'RADIUS: invalid Message-Authenticator — dropped');
    return;
  }
  // A NAS marked require_message_authenticator (default for new NAS rows,
  // migration 487) must sign every Access-Request: without it a spoofed request
  // cannot be told apart from a real one.
  if (nas && nas.require_message_authenticator && !codec.getAttr(pkt.attributes, ATTR.MESSAGE_AUTHENTICATOR)) {
    counters.authDropped++;
    counters.droppedNoMessageAuth++;
    logger.warn({ from: rinfo.address }, 'RADIUS: Access-Request without Message-Authenticator from a NAS that requires it — dropped');
    return;
  }
  // Replies always carry Message-Authenticator, as the first attribute
  // (Blast-RADIUS guidance), whether or not the request had one.
  const withMessageAuth = true;

  const username = codec.getString(pkt.attributes, ATTR.USER_NAME);
  const nasIpAddress = codec.getIp(pkt.attributes, ATTR.NAS_IP_ADDRESS) || rinfo.address;
  const callingStationId = codec.getString(pkt.attributes, ATTR.CALLING_STATION_ID);
  let accept = false;
  let subscriber = null;
  let reasonCode;
  if (!username) {
    reasonCode = AUTH_REASON.MISSING_USERNAME;
  } else {
    subscriber = await withNasTenant(nas, () => findSubscriber(username, nas.organization_id));
    if (!subscriber) {
      reasonCode = AUTH_REASON.UNKNOWN_OR_INACTIVE_USER;
    } else if (!subscriber.password) {
      // Require a non-empty stored password — never authenticate a blank credential.
      reasonCode = AUTH_REASON.PASSWORD_NOT_CONFIGURED;
    } else {
      const userPw = codec.getAttr(pkt.attributes, ATTR.USER_PASSWORD);
      const chapPw = codec.getAttr(pkt.attributes, ATTR.CHAP_PASSWORD);
      if (userPw) {
        const plain = codec.decodePapPassword(userPw, secret, pkt.authenticator);
        accept = plain !== null && timingSafeStrEqual(plain, subscriber.password);
      } else if (chapPw) {
        const challenge = codec.getAttr(pkt.attributes, ATTR.CHAP_CHALLENGE) || pkt.authenticator;
        accept = codec.verifyChap(chapPw, challenge, subscriber.password);
      } else {
        reasonCode = AUTH_REASON.UNSUPPORTED_AUTH_METHOD;
      }

      if (!reasonCode) {
        reasonCode = accept ? AUTH_REASON.ACCEPTED : AUTH_REASON.BAD_PASSWORD;
      }
    }
  }

  let attrsBuf;
  let code;
  if (accept) {
    code = CODE.ACCESS_ACCEPT;
    counters.accepts++;
    let plan = await withNasTenant(nas, () => findPlan(subscriber.plan_id));
    // §10.2: overlay an active time-based speed window so sessions coming up
    // DURING a window start at window speeds (CoA transitions handle sessions
    // already online). Fail open to plan speeds — a window lookup error must
    // never block authentication. Cost: one extra indexed lookup
    // (idx_plan_speed_windows_plan_id) per Access-Accept, incl. windowless
    // plans — accepted; add a windowed-plan cache only if auth-storm profiling
    // ever shows it matters.
    if (plan) {
      try {
        const win = await speedWindowService.getActiveWindow(plan.id);
        if (win) plan = speedWindowService.windowEffectivePlan(plan, win);
      } catch (err) {
        logger.warn({ err, planId: plan.id }, 'RADIUS: speed-window lookup failed — using plan speeds');
      }
    }
    attrsBuf = buildAcceptAttributes(subscriber, plan, withMessageAuth);
    logger.info({ from: rinfo.address, username }, 'RADIUS: Access-Accept');
  } else {
    code = CODE.ACCESS_REJECT;
    counters.rejects++;
    const parts = [coa.encodeAttributes([{ type: ATTR.REPLY_MESSAGE, value: 'Access denied' }])];
    if (withMessageAuth) parts.unshift(codec.messageAuthenticatorPlaceholder());
    attrsBuf = Buffer.concat(parts);
    logger.info({ from: rinfo.address, username }, 'RADIUS: Access-Reject');
  }

  const packet = coa.buildRadiusPacket(code, pkt.identifier, Buffer.alloc(16), attrsBuf);
  codec.signResponse(packet, pkt.authenticator, secret, withMessageAuth);
  respond(packet);
  // Best effort only, deliberately after the response is handed to the socket,
  // and skipped under load so a flood does not also become a write flood.
  if (saturated()) {
    counters.postAuthSkipped++;
    return;
  }
  persistAuthOutcome({
    nas,
    username,
    nasIpAddress,
    callingStationId,
    reply: accept ? 'Access-Accept' : 'Access-Reject',
    reasonCode,
  });
}

// ---------------------------------------------------------------------------
// Accounting-Request handling (UDP 1813)
// ---------------------------------------------------------------------------

async function handleAcct(msg, rinfo, respond) {
  counters.acctRequests++;
  let pkt;
  try {
    pkt = codec.decodePacket(msg);
  } catch (err) {
    counters.acctDropped++;
    logger.warn({ from: rinfo.address, err: err.message }, 'RADIUS: undecodable accounting packet — dropped');
    return;
  }
  if (pkt.code !== CODE.ACCOUNTING_REQUEST) { counters.acctDropped++; return; }

  const nas = await findNasByIp(rinfo.address);
  const secret = secretFor(nas);
  if (!secret) { counters.acctDropped++; return; }

  // Validate the Accounting-Request authenticator: MD5(packet-with-auth-zeroed + secret).
  const expected = coa.computeRequestAuthenticator(pkt.raw, secret);
  if (!expected.equals(pkt.authenticator)) {
    counters.acctDropped++;
    logger.warn({ from: rinfo.address }, 'RADIUS: bad Accounting-Request authenticator — dropped');
    return;
  }

  const statusInt = codec.getInt(pkt.attributes, ATTR.ACCT_STATUS_TYPE);
  const acctStatusType = ACCT_STATUS[statusInt] || null;
  if (!acctStatusType) {
    counters.acctDropped++;
    logger.warn({ from: rinfo.address, statusInt }, 'RADIUS: unsupported accounting status — no response');
    return;
  }
  const infrastructureStatus = acctStatusType === 'Accounting-On' || acctStatusType === 'Accounting-Off';
  try {
    // Accounting-On/Off are authenticated NAS lifecycle signals, not
    // subscriber sessions. Accept them as an explicit no-op without requiring
    // User-Name/Acct-Session-Id; all subscriber statuses must persist before ACK.
    if (!infrastructureStatus) {
      await withNasTenant(nas, () => require('./radiusAccountingService').ingestAccounting({
        acctStatusType,
        userName: codec.getString(pkt.attributes, ATTR.USER_NAME),
        acctSessionId: codec.getString(pkt.attributes, ATTR.ACCT_SESSION_ID),
        nasIpAddress: codec.getIp(pkt.attributes, ATTR.NAS_IP_ADDRESS) || rinfo.address,
        nasPortId: codec.getString(pkt.attributes, ATTR.NAS_PORT_ID),
        calledStationId: codec.getString(pkt.attributes, ATTR.CALLED_STATION_ID),
        callingStationId: codec.getString(pkt.attributes, ATTR.CALLING_STATION_ID),
        framedIpAddress: codec.getIp(pkt.attributes, ATTR.FRAMED_IP_ADDRESS),
        framedIpv6Prefix: codec.getIpv6Prefix(pkt.attributes),
        // REG-08: the DHCPv6-PD prefix and the WAN /128, never read before.
        delegatedIpv6Prefix: codec.getIpv6Prefix(pkt.attributes, ATTR.DELEGATED_IPV6_PREFIX),
        framedIpv6Address: codec.getIpv6Address(pkt.attributes),
        acctInputOctets: codec.getInt(pkt.attributes, ATTR.ACCT_INPUT_OCTETS),
        acctOutputOctets: codec.getInt(pkt.attributes, ATTR.ACCT_OUTPUT_OCTETS),
        acctInputGigawords: codec.getInt(pkt.attributes, ATTR.ACCT_INPUT_GIGAWORDS),
        acctOutputGigawords: codec.getInt(pkt.attributes, ATTR.ACCT_OUTPUT_GIGAWORDS),
        acctInputPackets: codec.getInt(pkt.attributes, ATTR.ACCT_INPUT_PACKETS),
        acctOutputPackets: codec.getInt(pkt.attributes, ATTR.ACCT_OUTPUT_PACKETS),
        acctSessionTime: codec.getInt(pkt.attributes, ATTR.ACCT_SESSION_TIME),
        acctTerminateCause: codec.getInt(pkt.attributes, ATTR.ACCT_TERMINATE_CAUSE),
        eventTimestamp: codec.getInt(pkt.attributes, ATTR.EVENT_TIMESTAMP),
        acctDelayTime: codec.getInt(pkt.attributes, ATTR.ACCT_DELAY_TIME),
        organizationId: nas ? nas.organization_id : null,
        nasId: nas ? nas.id : null,
        provenance: {
          source: 'radius_embedded',
          sourceIp: rinfo.address,
        },
      }));
    } else {
      await withNasTenant(nas, () => require('./radiusAccountingService').recordInfrastructureAccounting({
        organizationId: nas ? nas.organization_id : null,
        nasId: nas ? nas.id : null,
        acctStatusType,
        provenance: { source: 'radius_embedded', sourceIp: rinfo.address },
      }));
    }
    counters.acctIngested++;
  } catch (err) {
    counters.acctDropped++;
    logger.error({ from: rinfo.address, err: err.message }, 'RADIUS: accounting ingest failed — no response so NAS can retry');
    return;
  }

  // Acknowledge only after durable ingest/no-op succeeds. Withholding the
  // response on storage failure asks the NAS to retry instead of losing data.
  const packet = coa.buildRadiusPacket(CODE.ACCOUNTING_RESPONSE, pkt.identifier, Buffer.alloc(16), Buffer.alloc(0));
  codec.signResponse(packet, pkt.authenticator, secret, false);
  respond(packet);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Admit one datagram to `onMessage`, or drop it when its source is over its
 * rate or the server is at its in-flight cap. Returns the handler's promise,
 * or null when dropped.
 */
function admit(msg, rinfo, respond, onMessage, label) {
  if (!takeSourceToken(rinfo.address)) {
    counters.droppedSourceRate++;
    return null;
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    counters.droppedOverload++;
    return null;
  }
  inFlight++;
  return Promise.resolve()
    .then(() => onMessage(msg, rinfo, respond))
    .catch((err) => logger.error({ err: err.message }, `RADIUS ${label} handler error`))
    .finally(() => { inFlight--; });
}

function bind(socket, port, onMessage, label) {
  socket.on('message', (msg, rinfo) => {
    const respond = (buf) => socket.send(buf, rinfo.port, rinfo.address);
    admit(msg, rinfo, respond, onMessage, label);
  });
  socket.on('error', (err) => logger.error({ err: err.message, port }, `RADIUS ${label} socket error`));
  socket.bind(port, () => logger.info({ port }, `RADIUS ${label} server listening`));
}

/** Start the embedded RADIUS server (no-op unless RADIUS_SERVER_ENABLED=true). */
function start() {
  if (!config.radiusServer.enabled) return;
  if (authSocket || acctSocket) return; // already started
  authSocket = dgram.createSocket('udp4');
  acctSocket = dgram.createSocket('udp4');
  bind(authSocket, config.radiusServer.authPort, handleAuth, 'auth');
  bind(acctSocket, config.radiusServer.acctPort, handleAcct, 'accounting');
}

/** Stop the embedded RADIUS server. */
function stop() {
  if (authSocket) { try { authSocket.close(); } catch { /* ignore */ } authSocket = null; }
  if (acctSocket) { try { acctSocket.close(); } catch { /* ignore */ } acctSocket = null; }
}

/** Operational status for the /radius/server-status endpoint. */
function getStatus() {
  return {
    enabled: config.radiusServer.enabled,
    running: !!(authSocket || acctSocket),
    authPort: config.radiusServer.authPort,
    acctPort: config.radiusServer.acctPort,
    counters: { ...counters },
    limits: { maxInFlight: MAX_IN_FLIGHT, sourceRatePerSec: SOURCE_RATE_PER_SEC, sourceBurst: SOURCE_BURST },
    inFlight,
  };
}

module.exports = {
  start,
  stop,
  admit,
  resetIngressBounds,
  getStatus,
  // exported for tests
  handleAuth,
  handleAcct,
  _counters: counters,
};
