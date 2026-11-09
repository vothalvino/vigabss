// =============================================================================
// VigaBSS 5.0 — Cash bags (reseller app, phase 3)
// =============================================================================
// A numbered money bag carries a reseller's cash to the ISP. This module owns
// its state machine; every change goes through it, is checked against
// TRANSITIONS inside a transaction that holds the bag row (FOR UPDATE), and
// writes a cash_bag_events row with the actor and the time.
//
//   in_stock --handover--> with_carrier --dropoff--> at_reseller
//   at_reseller | with_carrier --seal--> ready_for_pickup --pickup--> in_transit
//   in_transit | ready_for_pickup --receive--> received
//   in_stock | with_carrier | at_reseller --void--> void   (no money in it)
//   ready_for_pickup | in_transit --lose--> lost           (money in it)
//   with_carrier --return--> in_stock, at_reseller --return--> with_carrier
//
// received, void and lost are terminal.
//
// Staff assign each bag to its point (a top-level reseller or collector) when
// they hand it to a carrier (migration 010): handover sets reseller_id, and
// from then on the bag shows on the point's page and the point may seal it
// (typing its serial proves it holds the bag). The carrier only carries: its
// drop-off just confirms the delivery, and only at the bag's own point. A bag
// with no point (taken back from a point, or handed over before migration
// 010) may be dropped off at any point assigned to the carrier.
//
// Money (services/resellerLedgerService.js; migration 006). Sealing a bag with
// a declared amount D (0 < D <= cash on hand) posts a bag_sealed entry of -D
// in the same transaction: the reseller no longer owes D, its limit frees at
// once, and in_bags (the declared amounts of its ready_for_pickup and
// in_transit bags) shows where that cash is, subtracted nowhere. Receiving
// with a count C posts only the difference, an adjustment of D - C when C
// differs (a short bag raises the debt, an over bag lowers it): over the
// bag's life the ledger moves by -C. A bag sealed before migration 006 with no
// bag_sealed line (the migration backfills them) is received the old way, a
// deposit of -D plus the difference, so no bag is counted twice or never. A
// lost bag posts nothing: its cash left the reseller's ledger when it was
// sealed, and the ISP absorbs the loss. No transition takes a sealed bag back
// to an unsealed state (void and return start only from the empty states).
//
// Lock order is the reseller row, then the bag: the same order as a
// collection (reseller, then invoices), so a seal and a concurrent collection
// cannot both pass the credit check, and a receive or a loss cannot race
// either. Every transition whose bag has or gets a reseller (handover,
// dropoff, seal, pickup, receive, lose, and void or return of an assigned
// bag) takes the
// reseller row FOR UPDATE before the bag, even when it moves no money: its
// cash_bag_events row (and dropoff's reseller_id) goes through a foreign key
// to resellers, and InnoDB checks that key with a shared lock on the reseller
// row. Taking the bag first would invert the order of a concurrent seal or
// receive on the same bag and deadlock.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'cashBag' });
const money = require('../utils/money');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const { requireOrgId } = require('../utils/requireOrgId');
const { inPlaceholders, buildBulkValues } = require('../utils/sqlBuild');
const auditLog = require('./auditLog');
const ledger = require('./resellerLedgerService');
const carrierService = require('./carrierService');
const Organization = require('../models/Organization');

const BAG_STATUSES = ['in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost'];
const TERMINAL_STATUSES = ['received', 'void', 'lost'];

// action -> the statuses it may start from and the status it ends in.
const TRANSITIONS = {
  handover: { from: ['in_stock'], to: 'with_carrier' },
  dropoff: { from: ['with_carrier'], to: 'at_reseller' },
  seal: { from: ['at_reseller', 'with_carrier'], to: 'ready_for_pickup' },
  pickup: { from: ['ready_for_pickup'], to: 'in_transit' },
  receive: { from: ['in_transit', 'ready_for_pickup'], to: 'received' },
  void: { from: ['in_stock', 'with_carrier', 'at_reseller'], to: 'void' },
  lose: { from: ['ready_for_pickup', 'in_transit'], to: 'lost' },
  return: { from: ['with_carrier', 'at_reseller'], to: null }, // to depends on from
};
const RETURN_TO = { with_carrier: 'in_stock', at_reseller: 'with_carrier' };

const MAX_AMOUNT = 9999999999.99;
const MAX_RANGE = 500;
const MAX_SERIALS = 500;
const SERIAL_RE = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

const BAG_COLUMNS = `id, organization_id, serial, status, reseller_id, carrier_user_id, declared_amount, counted_amount,
       currency, sealed_at, sealed_by, picked_up_at, picked_up_by, received_at, received_by, notes, created_by,
       created_at, updated_at`;

const toMoney = (v) => money.round(v === null || v === undefined || v === '' ? 0 : v);
const moneyOrNull = (v) => (v === null || v === undefined || v === '' ? null : toMoney(v));
const idOrNull = (v) => (v === null || v === undefined ? null : Number(v));

// -----------------------------------------------------------------------------
// The state machine
// -----------------------------------------------------------------------------

/** The status `action` leads to from `from`, or null when the move is not allowed. */
function nextStatus(action, from) {
  const t = TRANSITIONS[action];
  if (!t || !t.from.includes(from)) return null;
  return action === 'return' ? RETURN_TO[from] : t.to;
}

/** True when a bag may move from one status to the other by any action. */
function transitionAllowed(from, to) {
  return Object.keys(TRANSITIONS).some((action) => nextStatus(action, from) === to);
}

const ACTION_TEXT = {
  handover: 'handed to a carrier',
  dropoff: 'dropped off at a reseller',
  seal: 'sealed',
  pickup: 'picked up',
  receive: 'received',
  void: 'voided',
  lose: 'marked lost',
  return: 'returned',
};

function assertTransition(bag, action) {
  const to = nextStatus(action, bag.status);
  if (!to) {
    const err = new AppError(`Bag ${bag.serial} is ${bag.status} and cannot be ${ACTION_TEXT[action]}.`, 409, 'BAG_INVALID_TRANSITION');
    err.details = { serial: bag.serial, status: bag.status, action };
    throw err;
  }
  return to;
}

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

/** A serial as stored: trimmed and uppercase; null when it is not a valid serial. */
function normalizeSerial(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const serial = String(raw).trim().toUpperCase();
  return SERIAL_RE.test(serial) ? serial : null;
}

/** A list of serials, normalized and de-duplicated; 422 on a bad one or a bad count. */
function serialList(raw, field = 'serials', max = MAX_SERIALS) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) {
    throw new ValidationError(`${field} must list 1 to ${max} serials`);
  }
  const out = [];
  const bad = [];
  for (const value of raw) {
    const serial = normalizeSerial(value);
    if (!serial) bad.push(String(value).slice(0, 64));
    else if (!out.includes(serial)) out.push(serial);
  }
  if (bad.length) throw new ValidationError(`${field}: not a valid serial: ${bad.join(', ')}`, { invalid: bad });
  return out;
}

/** The serials of a POST /cash-bags body: { serial } or { prefix, from, to, pad? }. */
function serialsToRegister(body) {
  if (body.serial !== undefined && body.serial !== null) {
    const serial = normalizeSerial(body.serial);
    if (!serial) throw new ValidationError('serial must be 1 to 64 letters, digits, dots, dashes, underscores or slashes');
    return [serial];
  }
  const { from, to } = body;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new ValidationError('Send a serial, or a range: prefix, from and to (integers, from <= to)');
  }
  if (to - from + 1 > MAX_RANGE) throw new ValidationError(`A range registers at most ${MAX_RANGE} bags at a time`);
  const prefix = typeof body.prefix === 'string' ? body.prefix.trim().toUpperCase() : '';
  if (prefix && !/^[A-Z0-9][A-Z0-9._/-]*$/.test(prefix)) {
    throw new ValidationError('prefix may hold letters, digits, dots, dashes, underscores or slashes');
  }
  const pad = body.pad === undefined || body.pad === null ? String(to).length : body.pad;
  if (!Number.isInteger(pad) || pad < 0 || pad > 12) throw new ValidationError('pad must be 0 to 12 digits');
  const out = [];
  for (let n = from; n <= to; n++) {
    const serial = `${prefix}${String(n).padStart(pad, '0')}`;
    if (!SERIAL_RE.test(serial)) throw new ValidationError('A serial of the range is longer than 64 characters or not valid');
    out.push(serial);
  }
  return out;
}

/** A 2-decimal amount: > 0 (or >= 0 with allowZero), at most MAX_AMOUNT. */
function parseAmount(value, field, { allowZero = false } = {}) {
  const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount > MAX_AMOUNT
    || (allowZero ? amount < 0 : amount <= 0) || money.round(amount) !== amount) {
    throw new ValidationError(`${field} must be ${allowZero ? '0 or more' : 'more than 0'} with at most 2 decimals`);
  }
  return amount;
}

/** Optional coordinates sent together: { latitude, longitude } or nulls. */
function coordinates(body) {
  const lat = body.latitude;
  const lng = body.longitude;
  const none = (v) => v === undefined || v === null || v === '';
  if (none(lat) && none(lng)) return { latitude: null, longitude: null };
  const la = Number(lat);
  const lo = Number(lng);
  if (none(lat) || none(lng) || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    throw new ValidationError('latitude and longitude must be sent together, within -90..90 and -180..180');
  }
  return { latitude: Math.round(la * 1e7) / 1e7, longitude: Math.round(lo * 1e7) / 1e7 };
}

function cleanText(value, max = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

/** Names of the resellers by id (archived ones keep theirs): Map(id → name). */
async function resellerNames(orgId, ids) {
  const list = [...new Set((ids || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map();
  if (!list.length) return out;
  const [rows] = await db.query(
    `/* includes deleted rows: a bag keeps naming the reseller it belonged to */
     SELECT id, name FROM resellers WHERE organization_id = ? AND id IN (${inPlaceholders(list)})`,
    [orgId, ...list],
  );
  for (const r of rows || []) out.set(Number(r.id), r.name);
  return out;
}

function variance(row) {
  if (row.status !== 'received' || row.counted_amount === null || row.counted_amount === undefined
    || row.declared_amount === null || row.declared_amount === undefined) return null;
  return money.sub(toMoney(row.counted_amount), toMoney(row.declared_amount));
}

/** The staff view of a bag. */
function staffBag(row, { resellers = new Map(), users = new Map() } = {}) {
  const resellerId = idOrNull(row.reseller_id);
  const carrierId = idOrNull(row.carrier_user_id);
  return {
    id: Number(row.id),
    serial: row.serial,
    status: row.status,
    reseller_id: resellerId,
    reseller_name: resellerId === null ? null : resellers.get(resellerId) ?? null,
    carrier_user_id: carrierId,
    carrier_name: carrierId === null ? null : users.get(carrierId) ?? null,
    declared_amount: moneyOrNull(row.declared_amount),
    counted_amount: moneyOrNull(row.counted_amount),
    variance: variance(row),
    currency: row.currency,
    sealed_at: row.sealed_at ?? null,
    picked_up_at: row.picked_up_at ?? null,
    received_at: row.received_at ?? null,
    notes: row.notes ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

async function staffBags(orgId, rows) {
  const list = rows || [];
  const [resellers, users] = await Promise.all([
    resellerNames(orgId, list.map((r) => r.reseller_id)),
    carrierService.userNames(list.map((r) => r.carrier_user_id)),
  ]);
  return list.map((r) => staffBag(r, { resellers, users }));
}

/** The reseller app's view of a bag. */
function resellerBag(row) {
  return {
    id: Number(row.id),
    serial: row.serial,
    status: row.status,
    declared_amount: moneyOrNull(row.declared_amount),
    sealed_at: row.sealed_at ?? null,
    picked_up_at: row.picked_up_at ?? null,
  };
}

/** The carrier app's view of a bag: never an amount. */
function carrierBag(row, resellers = new Map()) {
  const resellerId = idOrNull(row.reseller_id);
  const travelling = row.status === 'in_transit';
  // Its point: where an empty bag goes (null = any of the carrier's points),
  // or whose cash a picked-up bag carries.
  return {
    id: Number(row.id),
    serial: row.serial,
    status: row.status,
    reseller_id: resellerId,
    reseller_name: resellerId !== null ? resellers.get(resellerId) ?? null : null,
    picked_up_at: travelling ? row.picked_up_at ?? null : null,
  };
}

function eventRow(row, { resellers = new Map(), users = new Map() } = {}) {
  const actor = idOrNull(row.actor_user_id);
  const carrier = idOrNull(row.carrier_user_id);
  const resellerId = idOrNull(row.reseller_id);
  return {
    id: Number(row.id),
    from_status: row.from_status ?? null,
    to_status: row.to_status,
    actor_user_id: actor,
    actor_name: actor === null ? null : users.get(actor) ?? null,
    amount: moneyOrNull(row.amount),
    reseller_id: resellerId,
    reseller_name: resellerId === null ? null : resellers.get(resellerId) ?? null,
    carrier_user_id: carrier,
    carrier_name: carrier === null ? null : users.get(carrier) ?? null,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    note: row.note ?? null,
    created_at: row.created_at,
  };
}

/** Events of the bags, oldest first: Map(bagId → [event]). */
async function eventsFor(orgId, bagIds) {
  const ids = [...new Set((bagIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT id, bag_id, from_status, to_status, actor_user_id, amount, reseller_id, carrier_user_id,
            latitude, longitude, note, created_at
       FROM cash_bag_events
      WHERE organization_id = ? AND bag_id IN (${inPlaceholders(ids)})
      ORDER BY bag_id ASC, id ASC`,
    [orgId, ...ids],
  );
  const list = rows || [];
  const [resellers, users] = await Promise.all([
    resellerNames(orgId, list.map((r) => r.reseller_id)),
    carrierService.userNames(list.flatMap((r) => [r.actor_user_id, r.carrier_user_id])),
  ]);
  for (const r of list) {
    const events = out.get(Number(r.bag_id));
    if (events) events.push(eventRow(r, { resellers, users }));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Transaction helpers
// -----------------------------------------------------------------------------

async function inTransaction(fn) {
  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  try {
    await conn.beginTransaction();
    const out = await fn(exec);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }
}

/** The bag row, re-read on the transaction (it sees its own writes). */
async function reloadBag(exec, orgId, bagId) {
  const [rows] = await exec(
    `SELECT ${BAG_COLUMNS} FROM cash_bags WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [bagId, orgId],
  );
  return rows && rows[0] ? rows[0] : null;
}

/** Lock one bag by id; null when it is not a live bag of the organization. */
async function lockBagById(exec, orgId, bagId) {
  const [rows] = await exec(
    `SELECT ${BAG_COLUMNS} FROM cash_bags
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
      FOR UPDATE`,
    [bagId, orgId],
  );
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Lock the reseller row a money-moving transition books on. It may have been
 * archived since the bag was sealed: the money still posts, so deleted rows
 * count here (unlike resellerLedgerService.lockReseller).
 */
async function lockBagReseller(exec, orgId, resellerId) {
  const [rows] = await exec(
    `/* includes deleted rows: a bag sealed before its reseller was archived is still received or lost */
     SELECT id, name, status, credit_limit, parent_id FROM resellers
      WHERE id = ? AND organization_id = ?
      FOR UPDATE`,
    [resellerId, orgId],
  );
  return rows && rows[0] ? rows[0] : null;
}

async function recordEvents(exec, events) {
  if (!events.length) return;
  const { placeholders, values } = buildBulkValues(events.map((e) => [
    e.orgId, e.bagId, e.from ?? null, e.to, e.actorId, e.amount ?? null, e.resellerId ?? null,
    e.carrierUserId ?? null, e.latitude ?? null, e.longitude ?? null, e.note ?? null,
  ]));
  await exec(
    `INSERT INTO cash_bag_events
       (organization_id, bag_id, from_status, to_status, actor_user_id, amount, reseller_id,
        carrier_user_id, latitude, longitude, note)
     VALUES ${placeholders}`,
    values,
  );
}

async function audit(entry) {
  try {
    await auditLog.log({ tableName: 'cash_bags', ...entry });
  } catch (err) {
    logger.error({ err }, 'Cash bag audit log failed after commit');
  }
}

function moved(result, expected) {
  if (!result || Number(result.affectedRows) !== expected) {
    throw new AppError('The bag changed while it was being updated; try again.', 409, 'BAG_CHANGED');
  }
}

// -----------------------------------------------------------------------------
// Register and hand over (staff)
// -----------------------------------------------------------------------------

/**
 * POST /cash-bags: register one serial or a range. Existing serials are
 * skipped and reported; 409 BAG_SERIALS_EXIST when none is new.
 * @returns {Promise<{ created: {id:number, serial:string}[], skipped: string[] }>}
 */
async function registerBags({ orgId, userId, body }) {
  requireOrgId(orgId, 'cashBagService.registerBags');
  const serials = serialsToRegister(body || {});
  const notes = cleanText(body && body.notes);
  const [existing] = await db.query(
    `/* includes deleted rows: the unique key covers archived bags too */
     SELECT serial FROM cash_bags WHERE organization_id = ? AND serial IN (${inPlaceholders(serials)})`,
    [orgId, ...serials],
  );
  const taken = new Set((existing || []).map((r) => String(r.serial).toUpperCase()));
  const skipped = serials.filter((s) => taken.has(s));
  const wanted = serials.filter((s) => !taken.has(s));
  if (!wanted.length) {
    const err = new AppError('Every serial is already registered.', 409, 'BAG_SERIALS_EXIST');
    err.details = { skipped };
    throw err;
  }
  const currency = await Organization.getCurrency(orgId);

  const created = await inTransaction(async (exec) => {
    const out = [];
    for (const serial of wanted) {
      try {
        const [result] = await exec(
          `INSERT INTO cash_bags (organization_id, serial, status, currency, notes, created_by)
           VALUES (?, ?, 'in_stock', ?, ?, ?)`,
          [orgId, serial, currency, notes, userId],
        );
        out.push({ id: Number(result.insertId), serial });
      } catch (err) {
        // Registered by someone else meanwhile: the statement alone rolls back.
        if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) { skipped.push(serial); continue; }
        throw err;
      }
    }
    await recordEvents(exec, out.map((b) => ({ orgId, bagId: b.id, from: null, to: 'in_stock', actorId: userId, note: 'Registrada' })));
    return out;
  });
  if (!created.length) {
    const err = new AppError('Every serial is already registered.', 409, 'BAG_SERIALS_EXIST');
    err.details = { skipped };
    throw err;
  }
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_register', recordId: created[0].id,
    newValues: { serials: created.map((b) => b.serial), skipped },
  });
  return { created, skipped };
}

/** Lock the bags named by serials or ids, ordered by id. */
async function lockBagsBy(exec, orgId, { serials, ids }, extraWhere = '', extraParams = []) {
  const byId = Array.isArray(ids) && ids.length;
  const list = byId ? ids : serials;
  const [rows] = await exec(
    `SELECT ${BAG_COLUMNS} FROM cash_bags
      WHERE organization_id = ? AND deleted_at IS NULL AND ${byId ? 'id' : 'serial'} IN (${inPlaceholders(list)})${extraWhere}
      ORDER BY id ASC
      FOR UPDATE`,
    [orgId, ...list, ...extraParams],
  );
  return rows || [];
}

function bagIdList(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SERIALS
    || raw.some((v) => !Number.isInteger(v) || v < 1)) {
    throw new ValidationError(`bag_ids must list 1 to ${MAX_SERIALS} bag ids`);
  }
  return [...new Set(raw)];
}

/**
 * POST /cash-bags/handover: in_stock -> with_carrier for the point the bags
 * are for, all or nothing. The point must be assigned to the carrier.
 */
async function handOver({ orgId, userId, carrierUserId, resellerId, serials: rawSerials, bagIds: rawIds }) {
  requireOrgId(orgId, 'cashBagService.handOver');
  const carrier = await carrierService.findCarrier(orgId, carrierUserId);
  if (!carrier) throw new ValidationError('carrier_user_id: not a carrier of this organization');
  const carrierId = Number(carrier.id);
  const point = await carrierService.assignedReseller(orgId, carrierId, resellerId);
  if (!point) {
    const err = new ValidationError('reseller_id: choose a point (reseller or collector) assigned to this carrier');
    err.code = 'POINT_NOT_ASSIGNED_TO_CARRIER';
    throw err;
  }
  const rid = Number(point.id);
  const byIds = rawIds !== undefined && rawIds !== null;
  const ids = byIds ? bagIdList(rawIds) : null;
  const serials = byIds ? null : serialList(rawSerials);

  const bags = await inTransaction(async (exec) => {
    // The point first (see the header): the events and the new reseller_id
    // check their foreign key against this row.
    if (!(await ledger.lockReseller(exec, orgId, rid))) throw new NotFoundError('Reseller');
    const rows = await lockBagsBy(exec, orgId, { serials, ids });
    const found = new Map(rows.map((r) => [byIds ? Number(r.id) : r.serial, r]));
    const wanted = byIds ? ids : serials;
    const failed = wanted.filter((key) => !found.has(key) || found.get(key).status !== 'in_stock')
      .map((key) => (found.has(key) ? found.get(key).serial : String(key)));
    if (failed.length) {
      const err = new AppError('Some bags are not in stock; nothing was handed over.', 422, 'BAGS_NOT_IN_STOCK');
      err.details = { failed };
      throw err;
    }
    const bagIds = rows.map((r) => Number(r.id));
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'with_carrier', carrier_user_id = ?, reseller_id = ?
        WHERE organization_id = ? AND status = 'in_stock' AND deleted_at IS NULL AND id IN (${inPlaceholders(bagIds)})`,
      [carrierId, rid, orgId, ...bagIds],
    );
    moved(result, bagIds.length);
    await recordEvents(exec, rows.map((r) => ({
      orgId, bagId: Number(r.id), from: 'in_stock', to: 'with_carrier', actorId: userId, carrierUserId: carrierId, resellerId: rid,
    })));
    return rows.map((r) => ({ id: Number(r.id), serial: r.serial, status: 'with_carrier' }));
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_handover', recordId: bags[0].id,
    newValues: { carrier_user_id: carrierId, reseller_id: rid, serials: bags.map((b) => b.serial) },
  });
  return {
    carrier_user_id: carrierId, carrier_name: carrierService.fullName(carrier), reseller_id: rid, reseller_name: point.name, bags,
  };
}

// -----------------------------------------------------------------------------
// Carrier: drop off and pick up
// -----------------------------------------------------------------------------

/**
 * POST /carrier-app/dropoff: the carrier confirms it delivered its own
 * with_carrier bags -> at_reseller, all or nothing. A bag assigned to another
 * point is refused; a bag with no point takes this one.
 */
async function dropOff({ orgId, carrierUserId, resellerId, serials: rawSerials, body = {} }) {
  requireOrgId(orgId, 'cashBagService.dropOff');
  const serials = serialList(rawSerials, 'serials', 50);
  const where = coordinates(body);
  const reseller = await carrierService.assignedReseller(orgId, carrierUserId, resellerId);
  if (!reseller) throw new NotFoundError('Reseller');
  const rid = Number(reseller.id);

  const bags = await inTransaction(async (exec) => {
    // The reseller first (see the header): the events and the new reseller_id
    // check their foreign key against this row.
    if (!(await ledger.lockReseller(exec, orgId, rid))) throw new NotFoundError('Reseller');
    // Only the caller's own stock matches: another carrier's bag, or one in
    // another state, fails exactly like a serial that does not exist.
    const rows = await lockBagsBy(exec, orgId, { serials }, " AND carrier_user_id = ? AND status = 'with_carrier'", [carrierUserId]);
    const found = new Set(rows.map((r) => r.serial));
    const failed = serials.filter((s) => !found.has(s));
    if (failed.length) {
      const err = new AppError('Some serials are not empty bags in your stock; nothing was dropped off.', 422, 'BAGS_NOT_IN_YOUR_STOCK');
      err.details = { failed };
      throw err;
    }
    // The carrier only carries: a bag staff assigned to another point stays
    // in its hands.
    const elsewhere = rows.filter((r) => r.reseller_id !== null && r.reseller_id !== undefined && Number(r.reseller_id) !== rid)
      .map((r) => r.serial);
    if (elsewhere.length) {
      const err = new AppError('Some bags are for another point; nothing was dropped off.', 422, 'BAGS_FOR_ANOTHER_POINT');
      err.details = { failed: elsewhere };
      throw err;
    }
    const bagIds = rows.map((r) => Number(r.id));
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'at_reseller', reseller_id = ?
        WHERE organization_id = ? AND carrier_user_id = ? AND status = 'with_carrier' AND deleted_at IS NULL
          AND id IN (${inPlaceholders(bagIds)})`,
      [rid, orgId, carrierUserId, ...bagIds],
    );
    moved(result, bagIds.length);
    await recordEvents(exec, rows.map((r) => ({
      orgId, bagId: Number(r.id), from: 'with_carrier', to: 'at_reseller', actorId: carrierUserId,
      resellerId: rid, carrierUserId, ...where,
    })));
    return rows.map((r) => ({ serial: r.serial, status: 'at_reseller' }));
  });
  await audit({
    userId: carrierUserId, organizationId: orgId, action: 'cash_bag_dropoff', recordId: null,
    newValues: { reseller_id: rid, serials: bags.map((b) => b.serial) },
  });
  return { reseller_id: rid, reseller_name: reseller.name, bags };
}

/**
 * POST /carrier-app/pickup: a ready_for_pickup bag of an assigned reseller,
 * by its serial -> in_transit. Any mismatch (unknown serial, another
 * reseller's or organization's bag, not ready) is the same 404. Two carriers
 * scanning the same bag: the second waits on the row lock, then finds it in
 * transit and gets the 404.
 */
async function pickUp({ orgId, carrierUserId, resellerId, serial: rawSerial, body = {} }) {
  requireOrgId(orgId, 'cashBagService.pickUp');
  const serial = normalizeSerial(rawSerial);
  const where = coordinates(body);
  const reseller = await carrierService.assignedReseller(orgId, carrierUserId, resellerId);
  if (!reseller || !serial) throw new NotFoundError('Bag');
  const rid = Number(reseller.id);

  const bag = await inTransaction(async (exec) => {
    // The reseller first (see the header), as a receive of the same bag does.
    if (!(await ledger.lockReseller(exec, orgId, rid))) throw new NotFoundError('Bag');
    const [rows] = await exec(
      `SELECT ${BAG_COLUMNS} FROM cash_bags
        WHERE organization_id = ? AND serial = ? AND reseller_id = ? AND status = 'ready_for_pickup' AND deleted_at IS NULL
        FOR UPDATE`,
      [orgId, serial, rid],
    );
    const row = rows && rows[0];
    if (!row) throw new NotFoundError('Bag');
    assertTransition(row, 'pickup');
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'in_transit', carrier_user_id = ?, picked_up_at = NOW(), picked_up_by = ?
        WHERE id = ? AND organization_id = ? AND status = 'ready_for_pickup' AND deleted_at IS NULL`,
      [carrierUserId, carrierUserId, row.id, orgId],
    );
    moved(result, 1);
    await recordEvents(exec, [{
      orgId, bagId: Number(row.id), from: 'ready_for_pickup', to: 'in_transit', actorId: carrierUserId,
      resellerId: rid, carrierUserId, ...where,
    }]);
    return reloadBag(exec, orgId, row.id);
  });
  await audit({
    userId: carrierUserId, organizationId: orgId, action: 'cash_bag_pickup', recordId: Number(bag.id),
    oldValues: { status: 'ready_for_pickup' }, newValues: { status: 'in_transit', reseller_id: rid },
  });
  return {
    id: Number(bag.id),
    serial: bag.serial,
    status: bag.status,
    reseller_id: rid,
    reseller_name: reseller.name,
    picked_up_at: bag.picked_up_at ?? null,
  };
}

// -----------------------------------------------------------------------------
// Reseller: seal
// -----------------------------------------------------------------------------

/**
 * POST /reseller-app/bags/seal: an empty bag of the collecting reseller ->
 * ready_for_pickup with the declared amount D (0 < D <= cash_on_hand).
 * Locks the reseller row, then the bag, and posts the bag_sealed entry of -D
 * in the same transaction.
 */
async function seal({ orgId, userId, resellerId, serial: rawSerial, declaredAmount }) {
  requireOrgId(orgId, 'cashBagService.seal');
  const declared = parseAmount(declaredAmount, 'declared_amount');
  const serial = normalizeSerial(rawSerial);
  if (!serial) throw new NotFoundError('Bag');

  const out = await inTransaction(async (exec) => {
    const reseller = await ledger.lockReseller(exec, orgId, resellerId);
    if (!reseller) throw new NotFoundError('Reseller');
    const [rows] = await exec(
      `SELECT ${BAG_COLUMNS} FROM cash_bags
        WHERE organization_id = ? AND serial = ? AND reseller_id = ? AND status IN ('at_reseller', 'with_carrier')
          AND deleted_at IS NULL
        FOR UPDATE`,
      [orgId, serial, resellerId],
    );
    const bag = rows && rows[0];
    if (!bag) throw new NotFoundError('Bag');
    assertTransition(bag, 'seal');

    const before = await ledger.summaryFor(orgId, resellerId, { exec, reseller });
    if (money.toCents(declared) > money.toCents(before.cash_on_hand)) {
      const err = new AppError(
        `You hold ${before.cash_on_hand.toFixed(2)} in cash; a bag cannot be sealed with more than that.`,
        409, 'BAG_AMOUNT_EXCEEDS_CASH',
      );
      err.details = { cash_on_hand: before.cash_on_hand, declared_amount: declared };
      throw err;
    }
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'ready_for_pickup', declared_amount = ?, sealed_at = NOW(), sealed_by = ?
        WHERE id = ? AND organization_id = ? AND status = ? AND deleted_at IS NULL`,
      [declared, userId, bag.id, orgId, bag.status],
    );
    moved(result, 1);
    await recordEvents(exec, [{
      orgId, bagId: Number(bag.id), from: bag.status, to: 'ready_for_pickup', actorId: userId,
      amount: declared, resellerId, carrierUserId: idOrNull(bag.carrier_user_id),
    }]);
    // The cash leaves the reseller's ledger now, not when the ISP receives it.
    const entryId = await ledger.appendEntry(exec, {
      orgId, resellerId, entryType: 'bag_sealed', amount: -declared, currency: bag.currency,
      note: `Bolsa ${bag.serial} sellada`, createdBy: userId, cashBagId: Number(bag.id),
    });
    const after = await ledger.summaryFor(orgId, resellerId, { exec, reseller });
    const counts = await ledger.bagCounts(orgId, resellerId, exec);
    return { bag: await reloadBag(exec, orgId, bag.id), summary: after, counts, entryId, from: bag.status };
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_seal', recordId: Number(out.bag.id),
    oldValues: { status: out.from },
    newValues: { status: 'ready_for_pickup', declared_amount: declared, reseller_id: Number(resellerId), ledger_entry_ids: [out.entryId] },
  });
  return out;
}

// -----------------------------------------------------------------------------
// Staff: receive, lose, void, return
// -----------------------------------------------------------------------------

/** The bag's reseller, read before the transaction so the reseller lock can come first. */
async function bagResellerId(orgId, bagId) {
  const id = Number(bagId);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('Bag');
  const [rows] = await db.query(
    'SELECT reseller_id FROM cash_bags WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  if (!rows || !rows[0]) throw new NotFoundError('Bag');
  return { id, resellerId: idOrNull(rows[0].reseller_id) };
}

/**
 * Lock the reseller (when the bag has one), then the bag; the bag must still
 * be that reseller's (409 BAG_CHANGED when it moved in between).
 */
async function lockResellerThenBag(exec, orgId, id, resellerId) {
  let reseller = null;
  if (resellerId !== null) reseller = await lockBagReseller(exec, orgId, resellerId);
  const bag = await lockBagById(exec, orgId, id);
  if (!bag) throw new NotFoundError('Bag');
  if (idOrNull(bag.reseller_id) !== resellerId) {
    throw new AppError('The bag changed while it was being updated; try again.', 409, 'BAG_CHANGED');
  }
  return { reseller, bag };
}

/** True when the bag's seal is on the ledger (every bag sealed since migration 006, and the ones it backfilled). */
async function hasSealEntry(exec, orgId, bagId) {
  const [rows] = await exec(
    `SELECT COUNT(*) AS sealed FROM reseller_ledger_entries
      WHERE organization_id = ? AND cash_bag_id = ? AND entry_type = 'bag_sealed'`,
    [orgId, bagId],
  );
  return Number(rows && rows[0] ? rows[0].sealed : 0) > 0;
}

/**
 * POST /cash-bags/:id/receive: count C, post the difference and close the bag.
 * From in_transit, or from ready_for_pickup when the reseller brought it in.
 * The declared amount left the ledger at sealing (bag_sealed), so a bag that
 * counts what was declared posts nothing; a bag without a bag_sealed line
 * (sealed before migration 006 and not backfilled) also posts the deposit.
 */
async function receive({ orgId, userId, bagId, countedAmount, note: rawNote }) {
  requireOrgId(orgId, 'cashBagService.receive');
  const counted = parseAmount(countedAmount, 'counted_amount', { allowZero: true });
  const note = cleanText(rawNote, 400);
  const { id, resellerId } = await bagResellerId(orgId, bagId);

  const out = await inTransaction(async (exec) => {
    const { reseller, bag } = await lockResellerThenBag(exec, orgId, id, resellerId);
    assertTransition(bag, 'receive');
    if (!reseller || bag.declared_amount === null || bag.declared_amount === undefined) {
      throw new AppError('This bag has no reseller or declared amount to receive.', 409, 'BAG_INVALID_TRANSITION');
    }
    const declared = toMoney(bag.declared_amount);
    const rid = Number(reseller.id);
    const entryIds = [];
    if (!(await hasSealEntry(exec, orgId, Number(bag.id)))) {
      entryIds.push(await ledger.appendEntry(exec, {
        orgId, resellerId: rid, entryType: 'deposit', amount: -declared, currency: bag.currency,
        note: `Bolsa ${bag.serial}`, createdBy: userId, cashBagId: Number(bag.id),
      }));
    }
    const difference = money.sub(declared, counted);
    if (money.toCents(difference) !== 0) {
      entryIds.push(await ledger.appendEntry(exec, {
        orgId, resellerId: rid, entryType: 'adjustment', amount: difference, currency: bag.currency,
        note: `Bolsa ${bag.serial}: declarado ${declared.toFixed(2)}, contado ${counted.toFixed(2)}`,
        createdBy: userId, cashBagId: Number(bag.id),
      }));
    }
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'received', counted_amount = ?, received_at = NOW(), received_by = ?
        WHERE id = ? AND organization_id = ? AND status = ? AND deleted_at IS NULL`,
      [counted, userId, bag.id, orgId, bag.status],
    );
    moved(result, 1);
    const inPerson = bag.status === 'ready_for_pickup' ? 'Entregada en persona por el revendedor' : null;
    await recordEvents(exec, [{
      orgId, bagId: Number(bag.id), from: bag.status, to: 'received', actorId: userId, amount: counted,
      resellerId: rid, carrierUserId: idOrNull(bag.carrier_user_id),
      note: [inPerson, note].filter(Boolean).join(' — ') || null,
    }]);
    const [entries] = entryIds.length ? await exec(
      `SELECT id, entry_type, amount, currency, note, created_at, payment_id, cash_session_id, created_by, cash_bag_id
         FROM reseller_ledger_entries
        WHERE organization_id = ? AND id IN (${inPlaceholders(entryIds)})
        ORDER BY id ASC`,
      [orgId, ...entryIds],
    ) : [[]];
    const summary = await ledger.summaryFor(orgId, rid, { exec, reseller });
    return {
      bag: await reloadBag(exec, orgId, bag.id),
      from: bag.status,
      declared,
      entryIds,
      entries: (entries || []).map((e) => ledger.entryRow({ ...e, cash_bag_serial: bag.serial })),
      summary,
      resellerId: rid,
    };
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_receive', recordId: Number(out.bag.id),
    oldValues: { status: out.from, declared_amount: out.declared },
    newValues: { status: 'received', counted_amount: counted, reseller_id: out.resellerId, ledger_entry_ids: out.entryIds },
  });
  return out;
}

/**
 * POST /cash-bags/:id/lost: a bag with money in it is gone. Nothing is posted:
 * its declared amount left the reseller's ledger when it was sealed
 * (bag_sealed), so the reseller does not owe it and the ISP absorbs the loss.
 * The bag leaves in_bags. An administrator who holds the reseller liable
 * records an adjustment.
 */
async function markLost({ orgId, userId, bagId, reason }) {
  requireOrgId(orgId, 'cashBagService.markLost');
  const why = cleanText(reason);
  const { id, resellerId } = await bagResellerId(orgId, bagId);
  const out = await inTransaction(async (exec) => {
    const { bag } = await lockResellerThenBag(exec, orgId, id, resellerId);
    assertTransition(bag, 'lose');
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'lost'
        WHERE id = ? AND organization_id = ? AND status = ? AND deleted_at IS NULL`,
      [bag.id, orgId, bag.status],
    );
    moved(result, 1);
    await recordEvents(exec, [{
      orgId, bagId: Number(bag.id), from: bag.status, to: 'lost', actorId: userId,
      amount: moneyOrNull(bag.declared_amount), resellerId, carrierUserId: idOrNull(bag.carrier_user_id), note: why,
    }]);
    return { bag: await reloadBag(exec, orgId, bag.id), from: bag.status };
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_lost', recordId: Number(out.bag.id),
    oldValues: { status: out.from }, newValues: { status: 'lost', reason: why },
  });
  return out.bag;
}

/** POST /cash-bags/:id/void: a bag with no declared money is taken out of use. */
async function voidBag({ orgId, userId, bagId, reason }) {
  requireOrgId(orgId, 'cashBagService.voidBag');
  const why = cleanText(reason);
  const { id, resellerId } = await bagResellerId(orgId, bagId);
  const out = await inTransaction(async (exec) => {
    // An at_reseller bag's event names its reseller: lock that row first.
    const { bag } = await lockResellerThenBag(exec, orgId, id, resellerId);
    assertTransition(bag, 'void');
    const [result] = await exec(
      `UPDATE cash_bags SET status = 'void'
        WHERE id = ? AND organization_id = ? AND status = ? AND deleted_at IS NULL`,
      [bag.id, orgId, bag.status],
    );
    moved(result, 1);
    await recordEvents(exec, [{
      orgId, bagId: Number(bag.id), from: bag.status, to: 'void', actorId: userId,
      resellerId: idOrNull(bag.reseller_id), carrierUserId: idOrNull(bag.carrier_user_id), note: why,
    }]);
    return { bag: await reloadBag(exec, orgId, bag.id), from: bag.status };
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_void', recordId: Number(out.bag.id),
    oldValues: { status: out.from }, newValues: { status: 'void', reason: why },
  });
  return out.bag;
}

/**
 * POST /cash-bags/:id/return: the carrier hands stock back (with_carrier ->
 * in_stock), or takes an empty bag back from a reseller (at_reseller ->
 * with_carrier, to `carrierUserId` or the carrier that dropped it off).
 */
async function returnBag({ orgId, userId, bagId, reason, carrierUserId = null }) {
  requireOrgId(orgId, 'cashBagService.returnBag');
  const why = cleanText(reason);
  const { id, resellerId } = await bagResellerId(orgId, bagId);
  let carrierForReturn = null;
  if (carrierUserId !== null && carrierUserId !== undefined) {
    const carrier = await carrierService.findCarrier(orgId, carrierUserId);
    if (!carrier) throw new ValidationError('carrier_user_id: not a carrier of this organization');
    carrierForReturn = Number(carrier.id);
  }
  const out = await inTransaction(async (exec) => {
    // An at_reseller bag's event names its reseller: lock that row first.
    const { bag } = await lockResellerThenBag(exec, orgId, id, resellerId);
    const to = assertTransition(bag, 'return');
    let carrier = null;
    if (to === 'in_stock') {
      const [result] = await exec(
        `UPDATE cash_bags SET status = 'in_stock', carrier_user_id = NULL, reseller_id = NULL
          WHERE id = ? AND organization_id = ? AND status = 'with_carrier' AND deleted_at IS NULL`,
        [bag.id, orgId],
      );
      moved(result, 1);
    } else {
      carrier = carrierForReturn ?? idOrNull(bag.carrier_user_id);
      if (carrier === null) throw new ValidationError('carrier_user_id: name the carrier that takes the bag back');
      if (carrierForReturn === null && !(await carrierService.findCarrier(orgId, carrier))) {
        throw new ValidationError('carrier_user_id: the carrier that dropped this bag off is no longer a carrier; name another');
      }
      const [result] = await exec(
        `UPDATE cash_bags SET status = 'with_carrier', reseller_id = NULL, carrier_user_id = ?
          WHERE id = ? AND organization_id = ? AND status = 'at_reseller' AND deleted_at IS NULL`,
        [carrier, bag.id, orgId],
      );
      moved(result, 1);
    }
    await recordEvents(exec, [{
      orgId, bagId: Number(bag.id), from: bag.status, to, actorId: userId,
      resellerId: idOrNull(bag.reseller_id), carrierUserId: carrier ?? idOrNull(bag.carrier_user_id), note: why,
    }]);
    return { bag: await reloadBag(exec, orgId, bag.id), from: bag.status, to };
  });
  await audit({
    userId, organizationId: orgId, action: 'cash_bag_return', recordId: Number(out.bag.id),
    oldValues: { status: out.from }, newValues: { status: out.to, carrier_user_id: idOrNull(out.bag.carrier_user_id), reason: why },
  });
  return out.bag;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

function statusFilter(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !BAG_STATUSES.includes(s));
  if (!list.length || bad.length) throw new ValidationError(`status must be one or more of: ${BAG_STATUSES.join(', ')}`);
  return [...new Set(list)];
}

function positiveIdFilter(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError(`${field} must be a positive integer`);
  return id;
}

/** GET /cash-bags: a page of the organization's bags, most recently changed first. */
async function listBags(orgId, query, { limit, offset }) {
  requireOrgId(orgId, 'cashBagService.listBags');
  const conditions = ['b.organization_id = ?', 'b.deleted_at IS NULL'];
  const params = [orgId];
  const statuses = statusFilter(query.status);
  if (statuses) { conditions.push(`b.status IN (${inPlaceholders(statuses)})`); params.push(...statuses); }
  const resellerId = positiveIdFilter(query.reseller_id, 'reseller_id');
  if (resellerId) { conditions.push('b.reseller_id = ?'); params.push(resellerId); }
  const carrierId = positiveIdFilter(query.carrier_user_id, 'carrier_user_id');
  if (carrierId) { conditions.push('b.carrier_user_id = ?'); params.push(carrierId); }
  const serial = typeof query.serial === 'string' ? query.serial.trim().toUpperCase() : '';
  if (serial) {
    if (serial.length > 64) throw new ValidationError('serial is at most 64 characters');
    conditions.push('b.serial LIKE ?');
    params.push(`%${serial.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (query.has_variance === '1' || query.has_variance === 'true') {
    conditions.push("b.status = 'received' AND b.counted_amount <> b.declared_amount");
  }
  const where = conditions.join(' AND ');
  const [rows] = await db.query(
    `SELECT b.id, b.organization_id, b.serial, b.status, b.reseller_id, b.carrier_user_id, b.declared_amount,
            b.counted_amount, b.currency, b.sealed_at, b.sealed_by, b.picked_up_at, b.picked_up_by, b.received_at,
            b.received_by, b.notes, b.created_by, b.created_at, b.updated_at
       FROM cash_bags b
      WHERE ${where}
      ORDER BY b.updated_at DESC, b.id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params,
  );
  const [[count]] = await db.query(`SELECT COUNT(*) AS total FROM cash_bags b WHERE ${where}`, params);
  return { rows: await staffBags(orgId, rows), total: Number(count?.total) || 0 };
}

/** Per-status counts of the organization's bags (every status present, 0 when none). */
async function statusCounts(orgId, resellerId = null) {
  const params = [orgId];
  let extra = '';
  if (resellerId !== null) { extra = ' AND reseller_id = ?'; params.push(resellerId); }
  const [rows] = await db.query(
    `SELECT status, COUNT(*) AS total FROM cash_bags
      WHERE organization_id = ? AND deleted_at IS NULL${extra}
      GROUP BY status`,
    params,
  );
  const out = Object.fromEntries(BAG_STATUSES.map((s) => [s, 0]));
  for (const r of rows || []) if (r.status in out) out[r.status] = Number(r.total) || 0;
  return out;
}

/** Variance of received bags, per reseller (or of one reseller). */
async function varianceRows(orgId, resellerId = null) {
  const params = [orgId];
  let extra = '';
  if (resellerId !== null) { extra = ' AND b.reseller_id = ?'; params.push(resellerId); }
  const [rows] = await db.query(
    `SELECT b.reseller_id, COUNT(*) AS received_bags,
            COALESCE(SUM(b.declared_amount), 0) AS declared_total,
            COALESCE(SUM(b.counted_amount), 0) AS counted_total,
            COALESCE(SUM(b.counted_amount - b.declared_amount), 0) AS variance,
            COALESCE(SUM(b.counted_amount <> b.declared_amount), 0) AS bags_with_difference
       FROM cash_bags b
      WHERE b.organization_id = ? AND b.deleted_at IS NULL AND b.status = 'received'${extra}
      GROUP BY b.reseller_id`,
    params,
  );
  return rows || [];
}

/** GET /cash-bags/summary. */
async function summary(orgId) {
  requireOrgId(orgId, 'cashBagService.summary');
  const [counts, variances, [[bagged]]] = await Promise.all([
    statusCounts(orgId),
    varianceRows(orgId),
    db.query(
      `SELECT COALESCE(SUM(declared_amount), 0) AS in_bags FROM cash_bags
        WHERE organization_id = ? AND deleted_at IS NULL AND status IN ('ready_for_pickup', 'in_transit')`,
      [orgId],
    ),
  ]);
  const names = await resellerNames(orgId, variances.map((v) => v.reseller_id));
  return {
    counts,
    in_bags: toMoney(bagged?.in_bags),
    resellers: variances.map((v) => ({
      reseller_id: idOrNull(v.reseller_id),
      reseller_name: v.reseller_id === null ? null : names.get(Number(v.reseller_id)) ?? null,
      received_bags: Number(v.received_bags) || 0,
      bags_with_difference: Number(v.bags_with_difference) || 0,
      declared_total: toMoney(v.declared_total),
      counted_total: toMoney(v.counted_total),
      variance: toMoney(v.variance),
    })).sort((a, b) => (a.reseller_name || '').localeCompare(b.reseller_name || '')),
  };
}

/** GET /cash-bags/:id: the bag and its history. */
async function getBag(orgId, bagId) {
  requireOrgId(orgId, 'cashBagService.getBag');
  const id = Number(bagId);
  if (!Number.isInteger(id) || id < 1) throw new NotFoundError('Bag');
  const [rows] = await db.query(
    `SELECT ${BAG_COLUMNS} FROM cash_bags WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [id, orgId],
  );
  if (!rows || !rows[0]) throw new NotFoundError('Bag');
  const [bag] = await staffBags(orgId, rows);
  const events = await eventsFor(orgId, [id]);
  return { ...bag, events: events.get(id) || [] };
}

/** GET /resellers/:id/bags: a page of one reseller's bags with their history, and its totals. */
async function resellerBagsPage(orgId, resellerId, { limit, offset }) {
  requireOrgId(orgId, 'cashBagService.resellerBagsPage');
  const [rows] = await db.query(
    `SELECT ${BAG_COLUMNS} FROM cash_bags
      WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [orgId, resellerId],
  );
  const [[count]] = await db.query(
    'SELECT COUNT(*) AS total FROM cash_bags WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL',
    [orgId, resellerId],
  );
  const bags = await staffBags(orgId, rows);
  const events = await eventsFor(orgId, bags.map((b) => b.id));
  const [counts, [v], bagged] = await Promise.all([
    statusCounts(orgId, resellerId),
    varianceRows(orgId, resellerId),
    ledger.inBags(orgId, resellerId),
  ]);
  return {
    rows: bags.map((b) => ({ ...b, events: events.get(b.id) || [] })),
    total: Number(count?.total) || 0,
    summary: {
      counts,
      in_bags: bagged,
      received_bags: Number(v?.received_bags) || 0,
      bags_with_difference: Number(v?.bags_with_difference) || 0,
      declared_total: toMoney(v?.declared_total),
      counted_total: toMoney(v?.counted_total),
      variance: toMoney(v?.variance),
    },
  };
}

/** GET /reseller-app/bags: the collecting reseller's live bags (not received, void or lost). */
async function resellerAppBags(orgId, resellerId) {
  requireOrgId(orgId, 'cashBagService.resellerAppBags');
  const [rows] = await db.query(
    `SELECT id, serial, status, declared_amount, sealed_at, picked_up_at
       FROM cash_bags
      WHERE organization_id = ? AND reseller_id = ? AND deleted_at IS NULL
        AND status IN ('at_reseller', 'with_carrier', 'ready_for_pickup', 'in_transit')
      ORDER BY FIELD(status, 'at_reseller', 'with_carrier', 'ready_for_pickup', 'in_transit'), serial ASC
      LIMIT 500`,
    [orgId, resellerId],
  );
  return (rows || []).map(resellerBag);
}

/** GET /carrier-app/bags: the carrier's own stock and the bags it carries. */
async function carrierAppBags(orgId, carrierUserId) {
  requireOrgId(orgId, 'cashBagService.carrierAppBags');
  const [rows] = await db.query(
    `SELECT id, serial, status, reseller_id, picked_up_at
       FROM cash_bags
      WHERE organization_id = ? AND carrier_user_id = ? AND deleted_at IS NULL
        AND status IN ('with_carrier', 'in_transit')
      ORDER BY FIELD(status, 'in_transit', 'with_carrier'), serial ASC
      LIMIT 500`,
    [orgId, carrierUserId],
  );
  const list = rows || [];
  const names = await resellerNames(orgId, list.map((r) => r.reseller_id));
  return list.map((r) => carrierBag(r, names));
}

/** Bag counts per reseller for the carrier's list: Map(id → { ready_for_pickup, empty_bags, to_deliver }). */
async function pickupCounts(orgId, resellerIds) {
  requireOrgId(orgId, 'cashBagService.pickupCounts');
  const ids = [...new Set((resellerIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map(ids.map((id) => [id, { ready_for_pickup: 0, empty_bags: 0, to_deliver: 0 }]));
  if (!ids.length) return out;
  const [rows] = await db.query(
    `SELECT reseller_id,
            COALESCE(SUM(status = 'ready_for_pickup'), 0) AS ready_for_pickup,
            COALESCE(SUM(status = 'at_reseller'), 0) AS empty_bags,
            COALESCE(SUM(status = 'with_carrier'), 0) AS to_deliver
       FROM cash_bags
      WHERE organization_id = ? AND reseller_id IN (${inPlaceholders(ids)}) AND deleted_at IS NULL
        AND status IN ('ready_for_pickup', 'at_reseller', 'with_carrier')
      GROUP BY reseller_id`,
    [orgId, ...ids],
  );
  for (const r of rows || []) {
    out.set(Number(r.reseller_id), {
      ready_for_pickup: Number(r.ready_for_pickup) || 0,
      empty_bags: Number(r.empty_bags) || 0,
      to_deliver: Number(r.to_deliver) || 0,
    });
  }
  return out;
}

module.exports = {
  BAG_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  MAX_RANGE,
  nextStatus,
  transitionAllowed,
  assertTransition,
  normalizeSerial,
  serialsToRegister,
  parseAmount,
  staffBag,
  staffBags,
  resellerBag,
  carrierBag,
  registerBags,
  handOver,
  dropOff,
  pickUp,
  seal,
  receive,
  markLost,
  voidBag,
  returnBag,
  listBags,
  summary,
  getBag,
  resellerBagsPage,
  resellerAppBags,
  carrierAppBags,
  pickupCounts,
};
