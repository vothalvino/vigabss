// =============================================================================
// VigaBSS — SNMP discovery scan executor (NET-26)
// =============================================================================
// POST /discovery-scans stored a 'pending' scan and nothing ever ran it, so
// discovery_results was never written and the onboarding flow had nothing to
// onboard. A scan is now a durable row plus a queued 'discovery-scan' job:
//
//   - the CIDR ranges are expanded once, capped at MAX_HOSTS_PER_SCAN, and
//     every address must pass the management-target guard (NET-21): no
//     loopback, link-local/metadata, multicast or operator-reserved ranges;
//   - hosts are probed with one SNMP GET of sysDescr/sysObjectID/sysName,
//     at most min(scan.concurrency, MAX_CONCURRENCY) at a time, using the
//     scan's own credentials and timeout;
//   - each responder that is not already one of the organization's devices
//     becomes a discovery_results row ('pending_review') with a vendor guess
//     from the sysObjectID enterprise number and a suggested SNMP profile;
//   - progress (scanned_hosts, discovered_hosts) is written as it goes, and a
//     scan deleted or cancelled mid-run stops between batches.
//
// The scan holds an advisory lock, so a job queued twice (a resume on two
// replicas) runs once. resumeDiscoveryScans() queues pending scans again at
// start-up, and restarts one left 'running' by a stopped process.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'discoveryScanService' });
const { managementTargetProblem } = require('../utils/managementTarget');
const { ValidationError } = require('../utils/errors');

const MAX_HOSTS_PER_SCAN = 4096;
const MAX_CONCURRENCY = 64;
const PROGRESS_EVERY = 32;

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysName: '1.3.6.1.2.1.1.5.0',
};

// sysObjectID enterprise numbers (1.3.6.1.4.1.<n>) of the vendors ISPs run.
const ENTERPRISES = {
  9: 'Cisco',
  2011: 'Huawei',
  2636: 'Juniper',
  3902: 'ZTE',
  4413: 'Ubiquiti',
  10002: 'Ubiquiti',
  41112: 'Ubiquiti',
  14988: 'MikroTik',
  161: 'Cambium',
  17713: 'Cambium',
  25053: 'Ruckus',
  5504: 'Zhone',
  6527: 'Nokia',
  8072: 'Net-SNMP',
};

function rangeError(message) {
  return new ValidationError(message, [{ field: 'cidr_ranges', message }]);
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0) >>> 0;
}

function intToIpv4(n) {
  return [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
}

/**
 * Expand a scan's CIDR ranges to host addresses. A /31 or /32 keeps every
 * address; larger blocks drop the network and broadcast addresses. Throws a
 * ValidationError naming the first bad range, the first address the guard
 * refuses, or a total over MAX_HOSTS_PER_SCAN.
 * @param {string[]|string} ranges  an array or its JSON
 * @returns {string[]}
 */
function expandCidrs(ranges) {
  const list = typeof ranges === 'string' ? JSON.parse(ranges) : ranges;
  if (!Array.isArray(list) || list.length === 0) throw new ValidationError('cidr_ranges must list at least one range');
  const hosts = new Set();
  for (const raw of list) {
    const range = String(raw).trim();
    const match = range.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
    const bits = match ? Number(match[2] ?? 32) : NaN;
    if (!match || match[1].split('.').some(o => Number(o) > 255) || bits > 32) {
      throw rangeError(`${range} is not an IPv4 address or CIDR range`);
    }
    const size = 2 ** (32 - bits);
    if (size > MAX_HOSTS_PER_SCAN) {
      throw rangeError(`${range} has more than ${MAX_HOSTS_PER_SCAN} addresses`);
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const base = (ipv4ToInt(match[1]) & mask) >>> 0;
    const first = size > 2 ? base + 1 : base;
    const last = size > 2 ? base + size - 2 : base + size - 1;
    for (let n = first; n <= last; n++) {
      const ip = intToIpv4(n);
      const problem = managementTargetProblem(ip);
      if (problem) {
        throw rangeError(`${range}: ${ip} ${problem}`);
      }
      hosts.add(ip);
      if (hosts.size > MAX_HOSTS_PER_SCAN) {
        throw rangeError(`A scan covers at most ${MAX_HOSTS_PER_SCAN} addresses`);
      }
    }
  }
  return [...hosts];
}

/** Vendor, model and device type guessed from what the host answered. */
function classify({ sysDescr, sysObjectID }) {
  const oid = String(sysObjectID || '').replace(/^\./, '');
  const enterprise = oid.startsWith('1.3.6.1.4.1.') ? Number(oid.split('.')[6]) : null;
  const manufacturer = (enterprise && ENTERPRISES[enterprise]) || null;
  const descr = String(sysDescr || '');
  let deviceType = 'other';
  if (/\bOLT\b|MA56\d\d|C3[0-9]{2}\b|C6[0-9]{2}\b/i.test(descr)) deviceType = 'olt';
  else if (/\bONU\b|\bONT\b/i.test(descr)) deviceType = 'onu';
  else if (/switch/i.test(descr)) deviceType = 'switch';
  else if (manufacturer === 'MikroTik' || manufacturer === 'Juniper' || /router|RouterOS/i.test(descr)) deviceType = 'router';
  else if (manufacturer === 'Ubiquiti' || manufacturer === 'Cambium') deviceType = /\bAP\b|access point|PtMP/i.test(descr) ? 'ptmp_ap' : 'outdoor_cpe';
  // RouterOS answers "RouterOS CCR2004-16G-2S+"; most others lead with the model.
  const model = (descr.match(/RouterOS\s+(\S+)/) || [])[1] || null;
  return { manufacturer, model, deviceType };
}

function varbindText(snmp, vb) {
  if (!vb || snmp.isVarbindError(vb) || vb.value === undefined || vb.value === null) return null;
  return Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
}

/**
 * One SNMP GET of the system group. Resolves null when the host does not
 * answer (timeout, refused, wrong community).
 */
async function probeHost(scan, ip) {
  const snmp = require('net-snmp');
  const { createSnmpSession, snmpGet } = require('./snmpPoller');
  const session = createSnmpSession({ ...scan, ip_address: ip }, { timeout: scan.timeout_ms, retries: 0 });
  try {
    const varbinds = await snmpGet(session, [OID.sysDescr, OID.sysObjectID, OID.sysName]);
    const [sysDescr, sysObjectID, sysName] = varbinds.map(vb => varbindText(snmp, vb));
    if (sysDescr === null && sysObjectID === null) return null;
    return { sysDescr, sysObjectID, sysName };
  } catch {
    return null;
  } finally {
    try { session.close(); } catch { /* already closed */ }
  }
}

async function suggestedProfileId(orgId, manufacturer, deviceType) {
  if (!manufacturer) return null;
  const [rows] = await db.query(
    `SELECT id FROM snmp_profiles
      WHERE (organization_id = ? OR is_system = 1) AND status = 'active' AND deleted_at IS NULL
        AND manufacturer = ? AND (device_type IS NULL OR device_type = ?)
      ORDER BY organization_id IS NULL, device_type IS NULL, id
      LIMIT 1`,
    [orgId, manufacturer, deviceType],
  );
  return rows[0]?.id ?? null;
}

const SNMP_VERSION_NUMBER = { v1: 1, v2c: 2, v3: 3 };

async function stillRunning(scanId, orgId) {
  const [[row]] = await db.query(
    'SELECT status, deleted_at FROM discovery_scans WHERE id = ? AND organization_id = ?',
    [scanId, orgId],
  );
  return Boolean(row && row.status === 'running' && !row.deleted_at);
}

/**
 * Run one scan. Safe to call for a scan in any state: only a pending scan,
 * or one left running by a stopped process, is (re)started.
 * @returns {Promise<{ status: string, scanned?: number, discovered?: number }|false>}
 *          false when another process holds the scan
 */
async function runScan(scanId, organizationId) {
  const { withAdvisoryLock } = require('../utils/advisoryLock');
  let outcome = { status: 'skipped' };
  const ran = await withAdvisoryLock(`discovery-scan:${scanId}`, async () => {
    const [[scan]] = await db.query(
      `SELECT * FROM discovery_scans
        WHERE id = ? AND organization_id = ? AND status IN ('pending','running') AND deleted_at IS NULL`,
      [scanId, organizationId],
    );
    if (!scan) return;

    let hosts;
    try {
      hosts = expandCidrs(scan.cidr_ranges);
    } catch (err) {
      const { message } = err;
      await db.query(
        `UPDATE discovery_scans SET status = 'failed', error_message = ?, scan_completed_at = NOW()
          WHERE id = ? AND organization_id = ?`,
        [message, scanId, organizationId],
      );
      outcome = { status: 'failed' };
      return;
    }

    // A scan found 'running' under the lock was interrupted: start it over.
    await db.query(
      "DELETE FROM discovery_results WHERE scan_id = ? AND organization_id = ? AND status = 'pending_review'",
      [scanId, organizationId],
    );
    await db.query(
      `UPDATE discovery_scans
          SET status = 'running', scan_started_at = NOW(), scan_completed_at = NULL, error_message = NULL,
              total_hosts = ?, scanned_hosts = 0, discovered_hosts = 0
        WHERE id = ? AND organization_id = ? AND status IN ('pending','running')`,
      [hosts.length, scanId, organizationId],
    );

    const [known] = await db.query(
      'SELECT ip_address FROM devices WHERE organization_id = ? AND deleted_at IS NULL AND ip_address IS NOT NULL',
      [organizationId],
    );
    const existing = new Set(known.map(r => r.ip_address));
    const width = Math.max(1, Math.min(Number(scan.concurrency) || 1, MAX_CONCURRENCY));
    let next = 0;
    let scanned = 0;
    let discovered = 0;
    let stopped = false;

    const record = async (ip, answer) => {
      const { manufacturer, model, deviceType } = classify(answer);
      await db.query(
        `INSERT INTO discovery_results
           (scan_id, organization_id, ip_address, hostname, sys_descr, sys_oid, snmp_version,
            manufacturer, model, device_type, suggested_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [scanId, organizationId, ip, answer.sysName ? answer.sysName.slice(0, 255) : null, answer.sysDescr,
          answer.sysObjectID ? answer.sysObjectID.slice(0, 255) : null, SNMP_VERSION_NUMBER[scan.snmp_version] || 2,
          manufacturer, model ? model.slice(0, 100) : null, deviceType,
          await suggestedProfileId(organizationId, manufacturer, deviceType)],
      );
      discovered++;
    };

    const progress = () => db.query(
      'UPDATE discovery_scans SET scanned_hosts = ?, discovered_hosts = ? WHERE id = ? AND organization_id = ?',
      [scanned, discovered, scanId, organizationId],
    );

    await Promise.all(Array.from({ length: Math.min(width, hosts.length) }, async () => {
      while (!stopped && next < hosts.length) {
        const ip = hosts[next++];
        // Already a device of this organization: nothing to onboard.
        const answer = existing.has(ip) ? null : await probeHost(scan, ip);
        if (answer) await record(ip, answer);
        scanned++;
        if (scanned % PROGRESS_EVERY === 0) {
          await progress();
          // A scan deleted or cancelled while it runs stops here.
          if (!await stillRunning(scanId, organizationId)) stopped = true;
        }
      }
    }));

    await progress();
    const [done] = await db.query(
      `UPDATE discovery_scans SET status = 'completed', scan_completed_at = NOW()
        WHERE id = ? AND organization_id = ? AND status = 'running' AND deleted_at IS NULL`,
      [scanId, organizationId],
    );
    outcome = { status: Number(done.affectedRows) === 1 ? 'completed' : 'stopped', scanned, discovered };
    logger.info({ scanId, organizationId, ...outcome }, 'Discovery scan finished');
  });
  return ran ? outcome : false;
}

/** Queue a scan's job; the row is durable, so a failure to queue is not fatal. */
async function queueScan(scanId, organizationId) {
  const jobQueue = require('./jobQueueService');
  await jobQueue.add('discovery-scan', { scanId: Number(scanId), organizationId: Number(organizationId) }, {
    jobId: `discovery-scan-${scanId}`,
    attempts: 1,
  }).catch((err) => {
    logger.warn({ err: err.message, scanId }, 'Could not queue the discovery scan; it resumes at the next start');
  });
}

/**
 * Queue every unfinished scan again (the in-process queue loses its jobs on a
 * restart). Called at start-up, over the primary and every isolated database.
 */
async function resumeDiscoveryScans() {
  let count = 0;
  const fanOut = require('./organizationFanOut');
  await fanOut.forEachDatabaseScope('resume_discovery_scans', async (scopeOrgId) => {
    const { sql, params } = fanOut.orgScopeFilter('organization_id', scopeOrgId);
    const [rows] = await db.query(
      `SELECT id, organization_id FROM discovery_scans
        WHERE status IN ('pending','running') AND deleted_at IS NULL AND organization_id IS NOT NULL${sql}`,
      params,
    );
    for (const row of rows) await queueScan(row.id, row.organization_id);
    count += rows.length;
  });
  if (count) logger.info({ count }, 'Resumed unfinished discovery scans');
  return count;
}

module.exports = {
  MAX_HOSTS_PER_SCAN,
  MAX_CONCURRENCY,
  expandCidrs,
  classify,
  probeHost,
  runScan,
  queueScan,
  resumeDiscoveryScans,
};
