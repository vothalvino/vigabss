// =============================================================================
// VigaBSS 5.0 — network incidents for technicians
// =============================================================================
// The watch judges the network tree every few minutes (linkHealthService) and
// keeps one incident per faulty line or piece of equipment:
//
//   - A fault opens an incident, or updates the one already open.
//   - A fault that clears does NOT close it. A link saturated every evening is
//     fine at 2 a.m.; closing it then would say "fixed" when nothing was. The
//     incident only records when it was last seen good.
//   - Only a technician closes an incident, and must say what was done.
//   - After closing it is watched for a week: the same fault reopens it.
//
// Every bad measurement is kept as a sample, so the incident shows its
// pattern over days (every evening, or once and continuously), which tells a
// capacity problem from a repair.
//
// The watch never writes to a customer. Customers who reported a fault are
// linked to its incident (reportFromPath), and hear back only when a
// technician closes it (incidentNoticeService).
// =============================================================================

const db = require('../config/database');
const { ValidationError, NotFoundError } = require('../utils/errors');
const linkHealth = require('./linkHealthService');
const logger = require('../utils/logger').child({ service: 'networkIncidentService' });

const WATCH_DAYS = 7;
const SAMPLE_KEEP_DAYS = 30;
const PATTERN_DAYS = 7;
const SLOT_MINUTES = 5;
const GAP_MINUTES = 15;
const MIN_COMMENT = 5;
const CAPACITY_CAUSES = ['airtime', 'capacity', 'capacity_live'];
const REPAIR_CAUSES = ['optical_drop', 'optical_weak', 'offline', 'port_down', 'errors'];

const bad = (verdict) => Boolean(verdict) && (verdict.state === 'degraded' || verdict.state === 'off');
const json = (value) => (value === null || value === undefined ? null : JSON.stringify(value));
const parse = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
};

/** Ids of a device and everything under it in the tree. */
function subtree(deviceId, parents) {
  const children = new Map();
  for (const [child, parent] of parents) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const out = new Set([deviceId]);
  const queue = [deviceId];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      if (!out.has(child)) { out.add(child); queue.push(child); }
    }
  }
  return [...out];
}

/** Active contracts served through a device: ONUs on it or below, and radios on its sectors. */
async function countAffected(orgId, deviceId) {
  const [rows] = await db.query(
    'SELECT id, parent_device_id FROM devices WHERE organization_id = ? AND deleted_at IS NULL', [orgId],
  );
  const parents = rows.filter((r) => r.parent_device_id).map((r) => [Number(r.id), Number(r.parent_device_id)]);
  const ids = subtree(Number(deviceId), parents);
  const marks = ids.map(() => '?').join(', ');
  const [[counted]] = await db.query(
    `SELECT COUNT(DISTINCT x.contract_id) AS total FROM (
        SELECT o.contract_id
          FROM olt_onus o
          JOIN contracts c ON c.id = o.contract_id AND c.organization_id = o.organization_id AND c.deleted_at IS NULL AND c.status = 'active'
         WHERE o.organization_id = ? AND o.olt_device_id IN (${marks})
        UNION
        SELECT d.contract_id
          FROM devices d
          JOIN contracts c ON c.id = d.contract_id AND c.organization_id = d.organization_id AND c.deleted_at IS NULL AND c.status = 'active'
         WHERE d.organization_id = ? AND d.deleted_at IS NULL AND d.contract_id IS NOT NULL AND d.id IN (${marks})
      ) x`,
    [orgId, ...ids, orgId, ...ids],
  );
  return Number(counted?.total || 0);
}

/**
 * Record one judgement of the tree. Opens, updates or reopens incidents;
 * never closes one.
 * @returns {Promise<{opened: number, updated: number, reopened: number}>}
 */
async function recordRun(orgId, report, now = new Date()) {
  const [existing] = await db.query(
    `SELECT id, device_id, part, status, worst_state
       FROM network_incidents
      WHERE organization_id = ? AND (status = 'open' OR (status = 'resolved' AND watch_until IS NOT NULL AND watch_until > ?))`,
    [orgId, now],
  );
  const key = (deviceId, part) => `${deviceId}:${part}`;
  const open = new Map();
  const watched = new Map();
  for (const row of existing) (row.status === 'open' ? open : watched).set(key(row.device_id, row.part), row);

  const result = { opened: 0, updated: 0, reopened: 0 };
  for (const [deviceId, node] of Object.entries(report.nodes || {})) {
    for (const [part, verdict] of [['equipment', node.equipment], ['line', node.uplink]]) {
      if (!verdict) continue;
      const k = key(deviceId, part);
      const current = open.get(k);
      if (!bad(verdict)) {
        if (current && verdict.state === 'good') {
          await db.query('UPDATE network_incidents SET last_good_at = ? WHERE id = ? AND organization_id = ?', [now, current.id, orgId]);
        }
        continue;
      }
      const evidence = json({ reasons: verdict.reasons, ...(verdict.top_clients ? { top_clients: verdict.top_clients } : {}) });
      let incidentId;
      if (current) {
        const worst = current.worst_state === 'off' || verdict.state === 'off' ? 'off' : 'degraded';
        await db.query(
          'UPDATE network_incidents SET last_seen_at = ?, evidence = ?, worst_state = ? WHERE id = ? AND organization_id = ?',
          [now, evidence, worst, current.id, orgId],
        );
        incidentId = current.id;
        result.updated += 1;
      } else if (watched.has(k)) {
        const previous = watched.get(k);
        await db.query(
          `UPDATE network_incidents
              SET status = 'open', reopened_count = reopened_count + 1, last_seen_at = ?, evidence = ?, worst_state = ?,
                  closed_at = NULL, watch_until = NULL, last_good_at = NULL
            WHERE id = ? AND organization_id = ?`,
          [now, evidence, verdict.state, previous.id, orgId],
        );
        incidentId = previous.id;
        result.reopened += 1;
      } else {
        const affected = await countAffected(orgId, deviceId);
        const [ins] = await db.query(
          `INSERT INTO network_incidents
             (organization_id, device_id, part, cause_code, worst_state, status, first_seen_at, last_seen_at, evidence, affected_contracts)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
          [orgId, Number(deviceId), part, String(verdict.reasons[0]?.code || 'unknown').slice(0, 40), verdict.state, now, now, evidence, affected],
        );
        incidentId = ins.insertId;
        result.opened += 1;
      }
      await db.query(
        'INSERT INTO network_incident_samples (organization_id, incident_id, sampled_at, state, reasons) VALUES (?, ?, ?, ?, ?)',
        [orgId, incidentId, now, verdict.state, json(verdict.reasons)],
      );
    }
  }
  return result;
}

/** The scheduled watch of one organization. Sends nothing to anyone. */
async function watch(orgId) {
  const report = await linkHealth.assess(orgId);
  const result = await recordRun(orgId, report);
  await db.query(
    `DELETE FROM network_incident_samples WHERE organization_id = ? AND sampled_at < DATE_SUB(NOW(), INTERVAL ${SAMPLE_KEEP_DAYS} DAY)`,
    [orgId],
  );
  if (result.opened || result.reopened) logger.info({ orgId, ...result }, 'network incidents changed');
  return result;
}

/**
 * The shape of an incident over the last days, from its samples.
 * recurring: bad on three or more days with good stretches in between
 * (the same hours every evening). continuous: bad without a break.
 */
function pattern(samples, causeCode, now = new Date()) {
  const since = now.getTime() - PATTERN_DAYS * 86400000;
  const times = samples
    .map((s) => ({ at: new Date(s.sampled_at).getTime(), reasons: parse(s.reasons) || [] }))
    .filter((s) => Number.isFinite(s.at) && s.at >= since)
    .sort((a, b) => a.at - b.at);
  const windows = [];
  for (const sample of times) {
    const last = windows[windows.length - 1];
    if (last && sample.at - last.end <= GAP_MINUTES * 60000) last.end = sample.at;
    else windows.push({ start: sample.at, end: sample.at });
  }
  const days = new Set(times.map((s) => new Date(s.at).toISOString().slice(0, 10)));
  let peak = null;
  for (const sample of times) {
    const reason = sample.reasons.find((r) => r.code === causeCode && Number.isFinite(Number(r.value)));
    if (!reason) continue;
    // "Worse" is lower for readings where low is bad.
    const lowIsBad = ['snr', 'ccq', 'battery', 'optical_weak', 'optical_drop', 'signal'].includes(causeCode);
    if (peak === null || (lowIsBad ? reason.value < peak : reason.value > peak)) peak = Number(reason.value);
  }
  const continuous = windows.length === 1 && times.length > 0;
  const recurring = days.size >= 3 && windows.length >= 3;
  let kind = 'equipment';
  if (CAPACITY_CAUSES.includes(causeCode)) kind = 'capacity';
  else if (REPAIR_CAUSES.includes(causeCode)) kind = 'repair';
  return {
    days_bad: days.size,
    days_window: PATTERN_DAYS,
    bad_minutes: times.length * SLOT_MINUTES,
    windows: windows.slice(-20).map((w) => ({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() })),
    recurring,
    continuous,
    peak,
    kind,
  };
}

const LIST_SQL = `SELECT i.id, i.device_id, i.part, i.cause_code, i.worst_state, i.status, i.first_seen_at, i.last_seen_at,
            i.last_good_at, i.evidence, i.affected_contracts, i.reopened_count, i.closed_at, i.closing_comment,
            i.customer_message, i.watch_until, d.name AS device_name, d.type AS device_type, s.name AS site_name,
            u.first_name AS closed_by_first_name, u.last_name AS closed_by_last_name,
            (SELECT COUNT(*) FROM network_incident_reports r WHERE r.incident_id = i.id AND r.organization_id = i.organization_id) AS reports,
            (SELECT COUNT(*) FROM network_incident_reports r WHERE r.incident_id = i.id AND r.organization_id = i.organization_id AND r.notice_status = 'draft') AS drafts
       FROM network_incidents i
       JOIN devices d ON d.id = i.device_id AND d.organization_id = i.organization_id /* includes deleted rows: an incident keeps the name of equipment that was later removed */
       LEFT JOIN sites s ON s.id = d.site_id AND s.deleted_at IS NULL
       LEFT JOIN users u ON u.id = i.closed_by /* includes deleted rows: who closed it stays on record */`;

function shape(row) {
  const closedBy = [row.closed_by_first_name, row.closed_by_last_name].filter(Boolean).join(' ') || null;
  return {
    id: Number(row.id),
    device_id: Number(row.device_id),
    device_name: row.device_name,
    device_type: row.device_type,
    site_name: row.site_name || null,
    part: row.part,
    cause_code: row.cause_code,
    worst_state: row.worst_state,
    status: row.status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    last_good_at: row.last_good_at || null,
    evidence: parse(row.evidence) || { reasons: [] },
    affected_contracts: Number(row.affected_contracts || 0),
    reopened_count: Number(row.reopened_count || 0),
    closed_at: row.closed_at || null,
    closed_by: closedBy,
    closing_comment: row.closing_comment || null,
    customer_message: row.customer_message || null,
    watch_until: row.watch_until || null,
    reports: Number(row.reports || 0),
    drafts: Number(row.drafts || 0),
  };
}

async function list(orgId, { status = 'open' } = {}) {
  const wanted = status === 'resolved' ? 'resolved' : 'open';
  const [rows] = await db.query(
    `${LIST_SQL}
      WHERE i.organization_id = ? AND i.status = ?
      ORDER BY (i.worst_state = 'off') DESC, i.affected_contracts DESC, i.last_seen_at DESC
      LIMIT 200`,
    [orgId, wanted],
  );
  return rows.map(shape);
}

async function get(orgId, id) {
  const [rows] = await db.query(`${LIST_SQL}\n      WHERE i.organization_id = ? AND i.id = ?`, [orgId, id]);
  if (!rows[0]) throw new NotFoundError('Incident');
  const incident = shape(rows[0]);
  const [samples] = await db.query(
    `SELECT sampled_at, state, reasons FROM network_incident_samples
      WHERE organization_id = ? AND incident_id = ? AND sampled_at >= DATE_SUB(NOW(), INTERVAL ${PATTERN_DAYS} DAY)
      ORDER BY sampled_at ASC`,
    [orgId, incident.id],
  );
  const [reports] = await db.query(
    `SELECT r.id, r.client_id, r.contract_id, r.channel, r.reported_at, r.notice_status, r.notice_text, r.notice_at,
            c.name AS client_name
       FROM network_incident_reports r
       JOIN clients c ON c.id = r.client_id AND c.organization_id = r.organization_id /* includes deleted rows: a report keeps its customer's name */
      WHERE r.organization_id = ? AND r.incident_id = ?
      ORDER BY r.reported_at ASC`,
    [orgId, incident.id],
  );
  return {
    ...incident,
    pattern: pattern(samples, incident.cause_code),
    reports: reports.map((r) => ({
      id: Number(r.id), client_id: Number(r.client_id), contract_id: Number(r.contract_id),
      client_name: r.client_name || null, channel: r.channel || null, reported_at: r.reported_at,
      notice_status: r.notice_status, notice_text: r.notice_text || null, notice_at: r.notice_at || null,
    })),
    drafts: reports.filter((r) => r.notice_status === 'draft').length,
  };
}

/**
 * Close an incident. The technician must say what was done; that comment is
 * what the customers who reported it are told, rewritten for them.
 */
async function close(orgId, id, userId, comment) {
  const text = String(comment ?? '').trim();
  if (text.replace(/\s+/g, '').length < MIN_COMMENT) throw new ValidationError('Say what was done to close this incident');
  if (text.length > 5000) throw new ValidationError('The comment is too long');
  const [result] = await db.query(
    `UPDATE network_incidents
        SET status = 'resolved', closed_at = NOW(), closed_by = ?, closing_comment = ?,
            watch_until = DATE_ADD(NOW(), INTERVAL ${WATCH_DAYS} DAY)
      WHERE id = ? AND organization_id = ? AND status = 'open'`,
    [userId || null, text, id, orgId],
  );
  if (!result.affectedRows) {
    const [[row]] = await db.query('SELECT status FROM network_incidents WHERE id = ? AND organization_id = ?', [id, orgId]);
    if (!row) throw new NotFoundError('Incident');
    throw new ValidationError('This incident is already closed');
  }
  let notices = { prepared: 0, sent: 0, drafts: 0 };
  try {
    notices = await require('./incidentNoticeService').prepare(orgId, Number(id));
  } catch (err) {
    // The incident is closed either way; the messages can be prepared again.
    logger.warn({ orgId, incidentId: id, err: err.message }, 'closing messages could not be prepared');
  }
  return { ...(await get(orgId, id)), notices };
}

/** A connection check as lines a technician can read at a glance. */
function summarize(path) {
  const lines = [`Conclusion: ${path.conclusion.side} (${path.conclusion.state})`];
  for (const f of path.findings || []) {
    const numbers = (f.reasons || []).map((r) => {
      const parts = [r.code];
      if (r.value !== undefined) parts.push(`${r.value}${r.limit !== undefined ? ` (limit ${r.limit})` : ''}`);
      if (r.mbps !== undefined && r.capacity_mbps !== undefined) parts.push(`${r.mbps}/${r.capacity_mbps} Mbps`);
      if (r.mbps !== undefined && r.plan_mbps !== undefined) parts.push(`${r.mbps}/${r.plan_mbps} Mbps`);
      if (r.normal !== undefined) parts.push(`normal ${r.normal}`);
      if (r.cause) parts.push(String(r.cause));
      return parts.join(' ');
    }).join('; ');
    lines.push(`- ${f.name || 'customer equipment'} [${f.side}, ${f.part}] ${f.state}: ${numbers}`);
    if (f.top_clients?.length) lines.push(`  carrying the most: ${f.top_clients.map((c) => `${c.name} ${c.mbps} Mbps`).join(', ')}`);
  }
  lines.push(`Path: ${(path.hops || []).map((h) => h.name || h.type).join(' > ')}`);
  if (path.saturation) lines.push(`Plan use: ${path.saturation.mbps}/${path.saturation.plan_mbps} Mbps (${path.saturation.pct}%)`);
  if (path.gaps?.length) lines.push(`Not checked: ${path.gaps.join(', ')}`);
  return lines.join('\n');
}

/**
 * Keep a connection check as evidence, and link the customer to the open
 * incident of each of OUR faults on their path (opening it if the watch has
 * not yet). A customer-side finding opens no incident.
 *
 * @param {{source: 'staff'|'assistant', channel?: string|null, conversationId?: number|null, ticketId?: number|null, reported?: boolean}} context
 *   reported: the customer themselves reported a problem (they are told when it is closed)
 * @returns {Promise<{check_id: number, summary: string, incident_ids: number[]}>}
 */
async function recordCheck(orgId, path, context = {}) {
  const summary = summarize(path);
  const source = context.source === 'assistant' ? 'assistant' : 'staff';
  const [ins] = await db.query(
    `INSERT INTO connection_checks
       (organization_id, contract_id, client_id, source, reported_via, conversation_id, ticket_id, conclusion_side, conclusion_state, summary, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, path.contract_id, path.client_id, source, context.channel || null, context.conversationId || null, context.ticketId || null,
      path.conclusion.side, path.conclusion.state, summary, JSON.stringify(path)],
  );
  const incidentIds = [];
  const ours = (path.findings || []).filter((f) => (f.side === 'access' || f.side === 'backhaul') && f.device_id);
  for (const finding of ours) {
    const [[openRow]] = await db.query(
      'SELECT id FROM network_incidents WHERE organization_id = ? AND device_id = ? AND part = ? AND status = \'open\' LIMIT 1',
      [orgId, finding.device_id, finding.part],
    );
    let incidentId = openRow?.id;
    if (!incidentId) {
      const report = { nodes: { [finding.device_id]: { equipment: finding.part === 'equipment' ? { state: finding.state, reasons: finding.reasons, top_clients: finding.top_clients } : null, uplink: finding.part === 'line' ? { state: finding.state, reasons: finding.reasons } : null } } };
      await recordRun(orgId, report);
      const [[created]] = await db.query(
        'SELECT id FROM network_incidents WHERE organization_id = ? AND device_id = ? AND part = ? AND status = \'open\' LIMIT 1',
        [orgId, finding.device_id, finding.part],
      );
      incidentId = created?.id;
    }
    if (!incidentId) continue;
    incidentIds.push(Number(incidentId));
    if (context.reported) {
      await db.query(
        `INSERT INTO network_incident_reports
           (organization_id, incident_id, client_id, contract_id, connection_check_id, channel, conversation_id, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE connection_check_id = VALUES(connection_check_id), channel = VALUES(channel), conversation_id = VALUES(conversation_id)`,
        [orgId, incidentId, path.client_id, path.contract_id, ins.insertId, context.channel || null, context.conversationId || null],
      );
    }
  }
  return { check_id: Number(ins.insertId), summary, incident_ids: incidentIds };
}

/** The connection checks kept for a contract, newest first. */
async function listChecks(orgId, contractId) {
  const [rows] = await db.query(
    `SELECT id, source, reported_via AS channel, ticket_id, conclusion_side, conclusion_state, summary, created_at
       FROM connection_checks
      WHERE organization_id = ? AND contract_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50`,
    [orgId, contractId],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), ticket_id: r.ticket_id ? Number(r.ticket_id) : null }));
}

/** The open incidents on a path, for telling a customer it is already known. */
async function openOnPath(orgId, path) {
  const ids = (path.hops || []).filter((h) => h.role !== 'customer' && h.device_id).map((h) => h.device_id);
  if (!ids.length) return [];
  const [rows] = await db.query(
    `SELECT id, device_id, part, cause_code, worst_state, first_seen_at
       FROM network_incidents
      WHERE organization_id = ? AND status = 'open' AND device_id IN (${ids.map(() => '?').join(', ')})`,
    [orgId, ...ids],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id), device_id: Number(r.device_id) }));
}

module.exports = {
  watch, recordRun, list, get, close, recordCheck, listChecks, openOnPath,
  // exported for tests
  pattern, summarize, subtree, countAffected, WATCH_DAYS, MIN_COMMENT,
};
