'use strict';

// =============================================================================
// Case-scoped preservation holds (REG-06)
// =============================================================================
// A hold keeps every connection log, accounting event, daily usage row and
// CGNAT binding of a subject within a UTC range out of the retention purge
// (retentionService), until it is released. It belongs to one government data
// request or one DSAR. Before this, rows were kept only when an IP lookup
// matched and pinned evidence: an ambiguous or unavailable lookup, a request's
// date range and a DSAR "legal hold" preserved nothing.
// =============================================================================

const net = require('net');
const db = require('../config/database');
const auditLog = require('./auditLog');
const { NotFoundError, ValidationError, ConflictError } = require('../utils/errors');

// A hold can be placed as soon as a case exists and until it is closed:
// preserving is not disclosing, and data deleted while a request awaits legal
// review cannot be recovered.
const GOV_OPEN = ['received', 'pending_legal_review', 'processing'];
const DSAR_OPEN = ['pending', 'in_review', 'legal_hold'];
// TIMESTAMP's floor: an open-ended DSAR hold covers everything held.
const BEGINNING = '1970-01-01 00:00:01.000';

function toTimestamp(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a date or date-time`);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function dayStart(value) {
  if (!value) return null;
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return `${day} 00:00:00.000`;
}

function dayEnd(value) {
  if (!value) return null;
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return `${day} 23:59:59.999`;
}

async function assertSubjectInOrg(conn, orgId, { clientId, contractId }) {
  if (clientId !== null) {
    // An archived client's sessions still need preserving.
    const [rows] = await conn.execute('SELECT id FROM clients /* includes deleted rows: an archived subject can be held */ WHERE id = ? AND organization_id = ? LIMIT 1', [clientId, orgId]);
    if (!rows.length) throw new ValidationError('client_id is not a client of this organization');
  }
  if (contractId !== null) {
    const [rows] = await conn.execute('SELECT id, client_id FROM contracts /* includes deleted rows: an ended contract can be held */ WHERE id = ? AND organization_id = ? LIMIT 1', [contractId, orgId]);
    if (!rows.length) throw new ValidationError('contract_id is not a contract of this organization');
    if (clientId !== null && Number(rows[0].client_id) !== Number(clientId)) {
      throw new ValidationError('contract_id does not belong to client_id');
    }
  }
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`${field} must be a positive integer`);
  return n;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  return text;
}

/**
 * Place a hold for a government data request. Subject and range default to
 * the request's own: its client, contract and IP address, and its
 * date_from..date_to (whole days, UTC), or else its observed instant.
 */
async function holdForGovRequest(orgId, govRequestId, body, userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM gov_data_requests WHERE id = ? AND organization_id = ? LIMIT 1 FOR UPDATE',
      [govRequestId, orgId],
    );
    const request = rows[0];
    if (!request) throw new NotFoundError('Government data request');
    if (!GOV_OPEN.includes(request.status)) {
      throw new ConflictError(`A ${request.status} request is closed; a preservation hold needs an open case`);
    }
    const subject = {
      clientId: optionalId(body.client_id, 'client_id') ?? (request.client_id === null ? null : Number(request.client_id)),
      contractId: optionalId(body.contract_id, 'contract_id') ?? (request.contract_id === null ? null : Number(request.contract_id)),
      username: optionalText(body.username, 'username', 253),
      ipAddress: optionalText(body.ip_address, 'ip_address', 45) ?? request.ip_address ?? null,
    };
    const heldFrom = toTimestamp(body.held_from, 'held_from')
      ?? dayStart(request.date_from) ?? toTimestamp(request.observed_at, 'observed_at');
    const heldTo = toTimestamp(body.held_to, 'held_to')
      ?? dayEnd(request.date_to) ?? toTimestamp(request.observed_at, 'observed_at');
    const id = await insertHold(conn, orgId, {
      govDataRequestId: govRequestId, dsarRequestId: null, ...subject, heldFrom, heldTo,
      reason: optionalText(body.reason, 'reason', 500) ?? `Government request ${request.authority_ref || govRequestId}`,
      userId,
    });
    await conn.commit();
    await auditLog.log({
      userId, organizationId: orgId, action: 'create', tableName: 'preservation_holds', recordId: id,
      newValues: { gov_data_request_id: govRequestId, ...subject, held_from: heldFrom, held_to: heldTo },
    });
    return get(orgId, id);
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Place an open-ended hold on everything held about a DSAR's client, for a
 * legal hold on the request.
 */
async function holdForDsar(exec, orgId, dsar, reason, userId) {
  const [existing] = await exec(
    'SELECT id FROM preservation_holds WHERE dsar_request_id = ? AND organization_id = ? AND released_at IS NULL LIMIT 1',
    [dsar.id, orgId],
  );
  if (existing.length) return Number(existing[0].id);
  return insertHold({ execute: exec }, orgId, {
    govDataRequestId: null, dsarRequestId: Number(dsar.id), clientId: Number(dsar.client_id), contractId: null,
    username: null, ipAddress: null, heldFrom: BEGINNING, heldTo: null,
    reason: reason || `Legal hold on DSAR ${dsar.id}`, userId,
  });
}

async function insertHold(conn, orgId, h) {
  if (h.clientId === null && h.contractId === null && h.username === null && h.ipAddress === null) {
    throw new ValidationError('A preservation hold needs a subject: client_id, contract_id, username or ip_address');
  }
  if (h.ipAddress !== null && !net.isIP(h.ipAddress)) throw new ValidationError('ip_address must be an IPv4 or IPv6 address');
  if (!h.heldFrom) throw new ValidationError('held_from is required when the case has no date range or observed time');
  if (h.heldTo !== null && h.heldTo < h.heldFrom) throw new ValidationError('held_to must not be before held_from');
  await assertSubjectInOrg(conn, orgId, h);
  const [result] = await conn.execute(
    `INSERT INTO preservation_holds
       (organization_id, gov_data_request_id, dsar_request_id, client_id, contract_id, username, ip_address,
        held_from, held_to, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, h.govDataRequestId, h.dsarRequestId, h.clientId, h.contractId, h.username, h.ipAddress,
      h.heldFrom, h.heldTo, h.reason, h.userId ?? null],
  );
  return Number(result.insertId);
}

async function get(orgId, id) {
  const [rows] = await db.query('SELECT * FROM preservation_holds WHERE id = ? AND organization_id = ?', [id, orgId]);
  if (!rows.length) throw new NotFoundError('Preservation hold');
  return rows[0];
}

async function listForCase(orgId, { govDataRequestId = null, dsarRequestId = null }) {
  const [rows] = await db.query(
    `SELECT * FROM preservation_holds
      WHERE organization_id = ? AND ${govDataRequestId !== null ? 'gov_data_request_id' : 'dsar_request_id'} = ?
      ORDER BY id DESC`,
    [orgId, govDataRequestId ?? dsarRequestId],
  );
  return rows;
}

/**
 * Release one hold; the purge resumes its rows' original clock.
 * @returns {Promise<object>} the released hold
 */
async function release(orgId, id, reason, userId) {
  const text = optionalText(reason, 'reason', 500);
  if (!text) throw new ValidationError('reason is required');
  const [result] = await db.query(
    `UPDATE preservation_holds SET released_at = NOW(3), released_by = ?, release_reason = ?
      WHERE id = ? AND organization_id = ? AND released_at IS NULL`,
    [userId, text, id, orgId],
  );
  if (Number(result.affectedRows) !== 1) {
    await get(orgId, id);
    throw new ConflictError('This preservation hold is already released');
  }
  await auditLog.log({
    userId, organizationId: orgId, action: 'release', tableName: 'preservation_holds', recordId: Number(id),
    newValues: { reason: text },
  });
  return get(orgId, id);
}

/** Release every active hold of a DSAR. @returns {Promise<number>} */
async function releaseForDsar(exec, orgId, dsarId, reason, userId) {
  const [result] = await exec(
    `UPDATE preservation_holds SET released_at = NOW(3), released_by = ?, release_reason = ?
      WHERE dsar_request_id = ? AND organization_id = ? AND released_at IS NULL`,
    [userId ?? null, reason, dsarId, orgId],
  );
  return Number(result.affectedRows);
}

module.exports = { holdForGovRequest, holdForDsar, releaseForDsar, release, get, listForCase, GOV_OPEN, DSAR_OPEN };
