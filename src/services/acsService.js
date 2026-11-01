// =============================================================================
// VigaBSS 5.0 — ACS (Auto Configuration Server) Service (§8.1/§8.3)
// =============================================================================
// Handles incoming CWMP/TR-069 HTTP requests from CPE devices.
// Endpoint: POST /acs/cwmp — mounted OUTSIDE the authenticated /api/v1 surface.
// CPE authentication: HTTP Basic on EVERY message (NET-04) — with the CPE's
// own acs_username/acs_password_hash, or with the ACS-wide credential
// (ACS_USERNAME/ACS_PASSWORD) for first contact by a device that has no
// credentials of its own yet. A missing or wrong credential gets a 401
// challenge; the serial+OUI lookup never stands in for authentication.
// §8.3: session events and errors are logged to cpe_session_logs.
// §8.3: DiagnosticsComplete Inform events route to cpeDiagnosticsService.
// §8.4: On Inform, tryAutoLinkSubscriber is called to match serial → subscriber.
// =============================================================================
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../config/database');
const CpeDevice = require('../models/CpeDevice');
const { parseCwmpEnvelope, buildCwmpResponse, CwmpParseError } = require('./cwmpXml');
const cwmpSessionService = require('./cwmpSessionService');
const cpeDiagnosticsService = require('./cpeDiagnosticsService');
const cpeSessionLogService = require('./cpeSessionLogService');
const cpeInventoryService = require('./cpeInventoryService');
const cacheService = require('./cacheService');
const logger = require('../utils/logger').child({ service: 'acsService' });

// ---------------------------------------------------------------------------
// Request guards (NET-05)
// ---------------------------------------------------------------------------

const CWMP_CONTENT_TYPES = ['text/xml', 'application/xml', 'application/soap+xml', 'text/plain'];

/** Body parser type check: SOAP XML, or no Content-Type (some CPEs omit it). */
function isCwmpBody(req) {
  return !req.headers['content-type'] || Boolean(req.is(CWMP_CONTENT_TYPES));
}

/** 415 for a non-empty body of any other type, before anything reads it. */
function requireCwmpContentType(req, res, next) {
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !isCwmpBody(req)) return res.status(415).send('');
  return next();
}

// ---------------------------------------------------------------------------
// Authentication (NET-04)
// ---------------------------------------------------------------------------

const ACS_CHALLENGE = 'Basic realm="VigaBSS ACS", charset="UTF-8"';
// An Inform normally carries a few dozen parameters; each one is an upsert.
const MAX_INFORM_PARAMETERS = 256;

function challenge(res) {
  return res.status(401).set('WWW-Authenticate', ACS_CHALLENGE).send('');
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return null;
  return { username: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1) };
}

const digest = value => crypto.createHash('sha256').update(String(value)).digest();

/** True when the credentials are the configured ACS-wide first-contact credential. */
function isSharedAcsCredential(username, password) {
  const { username: expectedUser, password: expectedPassword } = config.acs || {};
  if (!expectedUser || !expectedPassword) return false;
  const userOk = crypto.timingSafeEqual(digest(username), digest(expectedUser));
  const passwordOk = crypto.timingSafeEqual(digest(password), digest(expectedPassword));
  return userOk && passwordOk;
}

// Auto-registrations per source IP per hour, so one shared credential cannot
// fill cpe_devices with invented serials.
const AUTO_REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const autoRegistrations = new Map();

function takeAutoRegistration(ip) {
  const limit = (config.acs && config.acs.autoRegistrationsPerHour) || 0;
  const now = Date.now();
  for (const [key, entry] of autoRegistrations) {
    if (now - entry.start >= AUTO_REGISTRATION_WINDOW_MS) autoRegistrations.delete(key);
  }
  const key = ip || 'unknown';
  const entry = autoRegistrations.get(key) || { start: now, count: 0 };
  if (entry.count >= limit) return false;
  entry.count += 1;
  autoRegistrations.set(key, entry);
  return true;
}

function resetAutoRegistrations() {
  autoRegistrations.clear();
}

// ---------------------------------------------------------------------------
// verifyAcsCredentials
// ---------------------------------------------------------------------------

/**
 * Look up a CPE device by acs_username and verify the plaintext password.
 * @param {string} username
 * @param {string} passwordPlaintext
 * @returns {object|null} cpe_devices row or null
 */
async function verifyAcsCredentials(username, passwordPlaintext) {
  if (!username || !passwordPlaintext) return null;
  const [rows] = await db.query(
    'SELECT * FROM cpe_devices WHERE acs_username = ? AND deleted_at IS NULL LIMIT 1',
    [username],
  );
  if (!rows.length) return null;
  const device = rows[0];
  if (!device.acs_password_hash) return null;
  const ok = await bcrypt.compare(passwordPlaintext, device.acs_password_hash);
  return ok ? device : null;
}

// ---------------------------------------------------------------------------
// CWMP session (NET-19)
// ---------------------------------------------------------------------------
// A TR-069 session is: CPE Inform -> ACS InformResponse -> CPE empty POST ->
// ACS RPCs, one per POST, each answered by the CPE -> ACS empty 204 ends it.
// Inform was answered with the queued task's RPC instead of InformResponse,
// and the empty POST (the one place the ACS may send RPCs) ended the session,
// so standards-compliant CPEs faulted or never ran queued tasks. The session
// is tracked with a cookie set on the InformResponse; its token is kept in the
// shared cache so any replica can continue it.

const SESSION_COOKIE = 'cwmpsid';
const SESSION_TTL_SECONDS = 300;
const sessionKey = token => `acs:cwmp_session:${token}`;

async function openSession(res, cpeDevice) {
  const token = crypto.randomBytes(24).toString('hex');
  await cacheService.set(sessionKey(token), { cpeDeviceId: cpeDevice.id }, SESSION_TTL_SECONDS);
  res.set('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${SESSION_TTL_SECONDS}`);
}

function sessionToken(req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE}=`));
  const token = match ? match.slice(SESSION_COOKIE.length + 1) : '';
  return /^[0-9a-f]{48}$/.test(token) ? token : null;
}

/** The device of an open session, or null. */
async function sessionDevice(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const session = await cacheService.get(sessionKey(token));
  if (!session || !session.cpeDeviceId) return null;
  const [rows] = await db.query('SELECT * FROM cpe_devices WHERE id = ? AND deleted_at IS NULL LIMIT 1', [session.cpeDeviceId]);
  return rows[0] || null;
}

/** Send the next queued RPC of the session, or end the session with 204. */
async function dispatchNextOrEnd(res, cpeDevice, remoteIp) {
  const nextTask = await cwmpSessionService.getNextTask(cpeDevice.id);
  if (!nextTask) return res.status(204).send();
  await db.query(
    "UPDATE cpe_tasks SET status = 'in_progress', started_at = NOW() WHERE id = ?",
    [nextTask.id],
  );
  cpeSessionLogService.logSessionEvent({
    orgId: cpeDevice.organization_id,
    cpeDeviceId: cpeDevice.id,
    eventType: 'task_dispatched',
    taskType: nextTask.task_type,
    remoteIp: remoteIp || null,
  }).catch(() => {});
  return res
    .status(200)
    .set('Content-Type', 'text/xml; charset=utf-8')
    .send(cwmpSessionService.buildResponseForTask(nextTask));
}

/**
 * Fail tasks that were dispatched and never answered: the CPE dropped the
 * session, faulted outside it, or never authenticated its response. They sat
 * in_progress for ever and their requests never settled.
 */
async function reapStuckTasks(organizationId, { olderThanMinutes = 30 } = {}) {
  const [stuck] = await db.query(
    `SELECT id, task_type FROM cpe_tasks
      WHERE organization_id <=> ? AND status = 'in_progress'
        AND started_at < (NOW() - INTERVAL ? MINUTE)`,
    [organizationId, olderThanMinutes],
  );
  for (const task of stuck) {
    const [r] = await db.query(
      `UPDATE cpe_tasks SET status = 'failed', completed_at = NOW(),
              error_message = 'No response from the CPE within the session timeout'
        WHERE id = ? AND status = 'in_progress'`,
      [task.id],
    );
    if (r.affectedRows === 1 && task.task_type === 'set_parameter_values') {
      await require('./portalServiceRequestService').settleWifiRequestForTask(task.id, false, 'No response from the CPE');
    }
  }
  return { reaped: stuck.length };
}

// ---------------------------------------------------------------------------
// handleCwmpRequest
// ---------------------------------------------------------------------------

/**
 * Entry point for POST /acs/cwmp.
 */
async function handleCwmpRequest(req, res) {
  try {
    // 1. Empty POST: the CPE is ready for the ACS's RPCs. Its own credentials
    // or the session cookie identify it; anything else has no session, and a
    // 204 says there is nothing to do.
    const body = req.body;
    if (!body || (typeof body === 'string' && body.trim() === '')) {
      const creds = parseBasicAuth(req.headers['authorization'] || '');
      const device = (creds && await verifyAcsCredentials(creds.username, creds.password)) || await sessionDevice(req);
      if (!device) return res.status(204).send();
      return dispatchNextOrEnd(res, device, req.ip);
    }

    // Only the text parser fills the body (see app.js); anything else is not CWMP.
    if (typeof body !== 'string') return res.status(415).send('');
    const xmlString = body;

    // 2. Authenticate before the body is parsed. A device's own credentials
    // identify it; the ACS-wide credential only allows first contact below.
    let cpeDevice = null;
    let firstContact = false;
    const credentials = parseBasicAuth(req.headers['authorization'] || '');
    if (credentials) {
      cpeDevice = await verifyAcsCredentials(credentials.username, credentials.password);
      if (!cpeDevice) firstContact = isSharedAcsCredential(credentials.username, credentials.password);
    }
    // Later messages of a session the device opened with a valid Inform: a
    // CPE that authenticated (possibly with the ACS-wide credential) only on
    // its first request is still known by its session.
    if (!cpeDevice) {
      const fromSession = await sessionDevice(req);
      if (fromSession) {
        cpeDevice = fromSession;
        firstContact = false;
      }
    }
    if (!cpeDevice && !firstContact) {
      if (credentials) {
        // §8.3: log auth failure (the unauthenticated body is not stored)
        cpeSessionLogService.logSessionEvent({
          eventType: 'auth_failure',
          remoteIp: req.ip || null,
        }).catch(() => {});
      }
      return challenge(res);
    }

    // 3. Parse CWMP envelope
    let parsed;
    try {
      parsed = parseCwmpEnvelope(xmlString);
    } catch (err) {
      if (err instanceof CwmpParseError) return res.status(400).send('');
      throw err;
    }
    const { messageType, id: msgId, payload } = parsed;

    logger.debug({ messageType, msgId }, 'CWMP message received');

    // 4. Handle Inform and DiagnosticsComplete. With the ACS-wide credential the
    // device is resolved by serial+OUI, adopted or auto-registered — but only
    // when it has no credentials of its own.
    if (messageType === 'Inform' || messageType === 'DiagnosticsComplete') {
      const { deviceId: cwmpDeviceId } = payload;
      const serialNumber = cwmpDeviceId.serialNumber || '';
      const oui = cwmpDeviceId.oui || '';

      // Auto-register or fetch existing device
      if (!cpeDevice && firstContact && serialNumber && oui) {
        const [existing] = await db.query(
          'SELECT * FROM cpe_devices WHERE serial_number = ? AND oui = ? AND deleted_at IS NULL LIMIT 1',
          [serialNumber, oui],
        );
        if (existing.length) {
          // A device with its own credentials must use them.
          if (existing[0].acs_password_hash) return challenge(res);
          cpeDevice = existing[0];
        } else {
          // Serial-only bridge for inventory-minted rows. Warehouse receive and
          // install-time registration create cpe_devices rows with oui = NULL
          // (nobody types an OUI off a sticker), so the serial+oui lookup above
          // can never find them — before this bridge, the first Inform of every
          // inventory-tracked unit minted a DUPLICATE row and the serial the
          // tech recorded at install did nothing for TR-069.
          //
          // OUI IS NULL is a hard condition, not an optimisation: serials are
          // only unique per vendor, so a row whose OUI is already KNOWN and
          // differs is a different physical device — matching it would let a
          // foreign CPE adopt another unit's identity and queued tasks.
          // Preference order when several NULL-OUI rows share the serial
          // (cross-org collision — resolvable only by convention): the one
          // already assigned to a contract, then the oldest.
          const [invRows] = await db.query(
            `SELECT * FROM cpe_devices
             WHERE serial_number = ? AND oui IS NULL AND deleted_at IS NULL
               AND acs_password_hash IS NULL
             ORDER BY (contract_id IS NULL), id
             LIMIT 1`,
            [serialNumber],
          );
          if (invRows.length) {
            const inv = invRows[0];
            // Backfill the identity the Inform just proved; never overwrite a
            // value an operator already recorded.
            await db.query(
              `UPDATE cpe_devices SET
                 oui = ?,
                 manufacturer     = COALESCE(manufacturer, ?),
                 product_class    = COALESCE(product_class, ?),
                 hardware_version = COALESCE(hardware_version, ?),
                 software_version = COALESCE(software_version, ?)
               WHERE id = ?`,
              [oui, cwmpDeviceId.manufacturer || null, cwmpDeviceId.productClass || null,
                cwmpDeviceId.hwVersion || null, cwmpDeviceId.swVersion || null, inv.id],
            );
            const [fresh] = await db.query('SELECT * FROM cpe_devices WHERE id = ?', [inv.id]);
            cpeDevice = fresh[0];
            // Bridged devices row (installEquipment) inherits the proven
            // identity too — COALESCE keeps operator-entered values.
            if (cpeDevice.device_id) {
              await db.query(
                `UPDATE devices SET
                   manufacturer = COALESCE(manufacturer, ?),
                   model        = COALESCE(model, ?),
                   firmware     = COALESCE(firmware, ?)
                 WHERE id = ? AND deleted_at IS NULL`,
                [cwmpDeviceId.manufacturer || null, cwmpDeviceId.productClass || null,
                  cwmpDeviceId.swVersion || null, cpeDevice.device_id],
              ).catch(() => {});
            }
            logger.info(
              { cpeDeviceId: inv.id, serialNumber, oui },
              'CPE matched to inventory unit by serial; OUI backfilled',
            );
          }
        }
        if (!cpeDevice) {
          if (!takeAutoRegistration(req.ip)) {
            logger.warn({ remoteIp: req.ip, serialNumber }, 'CPE auto-registration limit reached for source');
            return res.status(429).set('Retry-After', '3600').send('');
          }
          // Auto-register
          const created = await CpeDevice.create({
            serial_number: serialNumber,
            oui,
            manufacturer: cwmpDeviceId.manufacturer || null,
            product_class: cwmpDeviceId.productClass || null,
            hardware_version: cwmpDeviceId.hwVersion || null,
            software_version: cwmpDeviceId.swVersion || null,
            last_inform_ip: req.ip || null,
            status: 'new',
          });
          cpeDevice = created;
          logger.info({ cpeDeviceId: created.id, serialNumber, oui }, 'CPE auto-registered');
        }
      }

      if (!cpeDevice) return challenge(res);

      if (Array.isArray(payload.parameters) && payload.parameters.length > MAX_INFORM_PARAMETERS) {
        logger.warn({ cpeDeviceId: cpeDevice.id, count: payload.parameters.length }, 'Inform parameter list truncated');
        payload.parameters = payload.parameters.slice(0, MAX_INFORM_PARAMETERS);
      }

      // Update last_inform_ip
      await db.query(
        'UPDATE cpe_devices SET last_inform_ip = ? WHERE id = ?',
        [req.ip || null, cpeDevice.id],
      );

      // §8.3: handle diagnostics complete event
      if (messageType === 'DiagnosticsComplete') {
        cpeDiagnosticsService.handleDiagnosticsComplete(cpeDevice, payload).catch(err =>
          logger.warn({ err: err.message, cpeDeviceId: cpeDevice.id }, 'handleDiagnosticsComplete failed'),
        );
        // Log inform event
        cpeSessionLogService.logSessionEvent({
          orgId: cpeDevice.organization_id,
          cpeDeviceId: cpeDevice.id,
          eventType: 'inform',
          messageType: 'DiagnosticsComplete',
          remoteIp: req.ip || null,
        }).catch(() => {});
      } else {
        // §8.4: attempt auto-link subscriber on each Inform
        cpeInventoryService.tryAutoLinkSubscriber(cpeDevice).catch(err =>
          logger.debug({ err: err.message, cpeDeviceId: cpeDevice.id }, 'tryAutoLinkSubscriber skipped'),
        );
        // §8.3: log inform event
        cpeSessionLogService.logSessionEvent({
          orgId: cpeDevice.organization_id,
          cpeDeviceId: cpeDevice.id,
          eventType: 'inform',
          messageType: 'Inform',
          remoteIp: req.ip || null,
        }).catch(() => {});
      }

      await cwmpSessionService.handleInform(cpeDevice, payload, cpeDevice.organization_id);

      // An Inform is always answered with InformResponse; queued RPCs go out on
      // the CPE's following empty POST, inside this session.
      await openSession(res, cpeDevice);
      return res
        .status(200)
        .set('Content-Type', 'text/xml; charset=utf-8')
        .send(buildCwmpResponse(msgId, 'InformResponse'));
    }

    // 5. Handle task responses — only a device's own credentials identify it
    if (!cpeDevice) return challenge(res);

    // Find in-progress task for this device
    const [inProgress] = await db.query(
      "SELECT * FROM cpe_tasks WHERE cpe_device_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1",
      [cpeDevice.id],
    );
    const activeTask = inProgress[0] || null;

    if (activeTask) {
      if (messageType === 'Fault') {
        const faultMsg = `${payload.faultCode}: ${payload.faultString}`;
        await db.query(
          'UPDATE cpe_tasks SET status = ?, error_message = ?, completed_at = NOW() WHERE id = ?',
          ['failed', faultMsg, activeTask.id],
        );
        if (activeTask.task_type === 'set_parameter_values') {
          await require('./portalServiceRequestService').settleWifiRequestForTask(activeTask.id, false, faultMsg);
        }
        // §8.3: log fault
        cpeSessionLogService.logSessionEvent({
          orgId: cpeDevice.organization_id,
          cpeDeviceId: cpeDevice.id,
          eventType: 'fault',
          messageType: 'Fault',
          taskType: activeTask.task_type,
          faultCode: payload.faultCode,
          faultString: payload.faultString,
          remoteIp: req.ip || null,
          rawBody: xmlString,
        }).catch(() => {});
      } else {
        // §8.3: check if this is a diagnostic result response
        const taskParams = activeTask.parameters
          ? (typeof activeTask.parameters === 'string' ? JSON.parse(activeTask.parameters) : activeTask.parameters)
          : {};
        if (taskParams && taskParams._diagId && messageType === 'GetParameterValuesResponse') {
          await cpeDiagnosticsService.storeDiagnosticResults(
            cpeDevice.id,
            payload.parameterList || [],
            taskParams,
          );
        }
        await cwmpSessionService.processTaskResponse(activeTask, payload);
        // §8.3: log task response
        cpeSessionLogService.logSessionEvent({
          orgId: cpeDevice.organization_id,
          cpeDeviceId: cpeDevice.id,
          eventType: 'task_response',
          messageType,
          taskType: activeTask.task_type,
          remoteIp: req.ip || null,
        }).catch(() => {});
      }
    }

    // Next queued RPC, or end the session.
    return dispatchNextOrEnd(res, cpeDevice, req.ip);

  } catch (err) {
    logger.error({ err: err.message }, 'CWMP request error');
    res.status(500).send('');
  }
}

module.exports = {
  handleCwmpRequest,
  reapStuckTasks,
  verifyAcsCredentials,
  isCwmpBody,
  requireCwmpContentType,
  isSharedAcsCredential,
  resetAutoRegistrations,
};
