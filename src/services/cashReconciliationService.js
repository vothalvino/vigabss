// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Service
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'cashReconciliation' });
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { ORG_SETTING_DEFS } = require('./settingsCatalog');

const RULE_KEYS = ['cashier_match_tolerance', 'cashier_max_open_hours', 'cashier_pickup_threshold', 'cashier_pickup_strict'];

/**
 * The organization's cashier rules (Settings): how large a difference still
 * counts as a match, and how long a cashier may stay open.
 */
async function rules(orgId, exec = db.query.bind(db)) {
  const keys = RULE_KEYS;
  const values = Object.fromEntries(keys.map((k) => [k, ORG_SETTING_DEFS[k].default]));
  const [rows] = await exec(
    `SELECT setting_key, setting_value FROM organization_settings
      WHERE organization_id = ? AND setting_key IN (${keys.map(() => '?').join(', ')})`,
    [orgId, ...keys],
  );
  for (const row of rows || []) {
    // A stored value the catalog would refuse today falls back to the default.
    if (!keys.includes(row.setting_key)) continue;
    if (ORG_SETTING_DEFS[row.setting_key].validate(String(row.setting_value)) === null) values[row.setting_key] = row.setting_value;
  }
  return {
    tolerance: Number(values.cashier_match_tolerance),
    maxOpenHours: Number(values.cashier_max_open_hours),
    pickupThreshold: Number(values.cashier_pickup_threshold),
    pickupStrict: values.cashier_pickup_strict === 'true',
  };
}

/**
 * A supervisor sets when cash should be handed in and whether that is
 * enforced. The same keys are on the Settings page; this is the door for
 * whoever supervises the cashiers.
 */
async function setPickupRules(orgId, { pickup_threshold: threshold, pickup_strict: strict }) {
  const changes = [];
  if (threshold !== undefined) changes.push(['cashier_pickup_threshold', String(threshold)]);
  if (strict !== undefined) changes.push(['cashier_pickup_strict', strict ? 'true' : 'false']);
  for (const [key, value] of changes) {
    const problem = ORG_SETTING_DEFS[key].validate(value);
    if (problem) throw new ValidationError(`${key} ${problem}`);
  }
  for (const [key, value] of changes) {
    await db.query(
      `INSERT INTO organization_settings (organization_id, setting_key, setting_value)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [orgId, key, value],
    );
  }
  return rules(orgId);
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

/**
 * What an open cashier's drawer holds: the opening count, plus the cash
 * payments its owner recorded since, minus the pickups the owner confirmed.
 * A pickup still waiting for the owner is reported apart and does not count.
 */
async function drawer(orgId, session, exec = db.query.bind(db)) {
  const [sumRows] = await exec(
    `SELECT COALESCE(SUM(amount), 0) AS collected FROM payments
      WHERE ${SESSION_PAYMENTS} AND created_at BETWEEN ? AND NOW()`,
    [orgId, session.agent_user_id, session.opened_at],
  );
  const [pickupRows] = await exec(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM cash_reconciliation_pickups
      WHERE organization_id = ? AND session_id = ? AND status IN ('pending', 'confirmed')
      GROUP BY status`,
    [orgId, session.id],
  );
  const by = Object.fromEntries((pickupRows || []).map((r) => [r.status, r]));
  const opening = round2(session.opening_total || 0);
  const collected = round2(sumRows[0].collected);
  const handedIn = round2(by.confirmed ? by.confirmed.total : 0);
  return {
    opening,
    collected,
    handedIn,
    pending: Number(by.pending ? by.pending.n : 0),
    pendingTotal: round2(by.pending ? by.pending.total : 0),
    cashOnHand: round2(opening + collected - handedIn),
  };
}

/**
 * What the drawer should hold when this person opens: the count of their last
 * close. null when there is none to compare with (a first cashier, or one
 * closed before the cash stayed in the drawer).
 */
async function openingExpectation(orgId, userId, exec = db.query.bind(db)) {
  const [rows] = await exec(
    `SELECT counted_total FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status IN ('closed', 'approved', 'disputed')
        AND opening_total IS NOT NULL AND counted_total IS NOT NULL AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId, userId],
  );
  return rows[0] ? round2(rows[0].counted_total) : null;
}

const toCents = (v) => Math.round(Number(v) * 100);
/** Whether a closed session's count is within the tolerance of what was expected. */
function matches(variance, tolerance) {
  return Math.abs(toCents(variance)) <= toCents(tolerance);
}

// The cash a session should hold: live, completed cash payments the agent
// recorded. The window is matched on created_at, a DATETIME like opened_at;
// payment_date is a DATE, which compares as midnight, so every payment taken
// on the opening day fell before the session began.
const SESSION_PAYMENTS = `organization_id = ?
       AND payment_method = 'cash'
       AND recorded_by = ?
       AND status = 'completed'
       AND deleted_at IS NULL`;

/**
 * Open a new reconciliation session for an agent, with the cash they counted
 * in the drawer. Agent must not already have an open session for the same org.
 */
async function openSession({ organizationId, agentUserId, notes, openingTotal }) {
  // Check for an existing open session
  const [existing] = await db.query(
    `SELECT id FROM cash_reconciliation_sessions
     WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL`,
    [organizationId, agentUserId],
  );
  if (existing.length > 0) {
    throw new ValidationError('Agent already has an open reconciliation session');
  }

  // The shift starts by counting the drawer. What it should hold is the
  // count of this person's last close; a difference is kept on the session
  // for a supervisor to see.
  const opening = round2(openingTotal);
  if (!Number.isFinite(opening) || opening < 0) {
    throw new ValidationError('The cash counted when opening is required');
  }
  const expected = await openingExpectation(organizationId, agentUserId);
  const [result] = await db.query(
    `INSERT INTO cash_reconciliation_sessions
       (organization_id, agent_user_id, opened_at, status, notes, opening_total, opening_expected)
     VALUES (?, ?, NOW(), 'open', ?, ?, ?)`,
    [organizationId, agentUserId, notes || null, opening, expected],
  );

  const [rows] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ?',
    [result.insertId],
  );
  logger.info({ sessionId: result.insertId, agentUserId }, 'Reconciliation session opened');
  return rows[0];
}

/**
 * Close a session: freeze the cash payments the agent made during the session
 * window, and set expected_total = opening + those payments - confirmed
 * pickups, and variance = counted_total - expected_total. Closing is a count,
 * not a hand-in: the cash stays in the drawer for the next opening. The frozen list (migration 521) is what the closed
 * session's detail shows, so a payment deleted, refunded or re-dated after
 * the close cannot make the list and the total disagree.
 */
async function closeSession(sessionId, orgId, countedTotal) {
  const conn = await db.getConnection();
  let expectedTotal;
  let variance;
  let matched;
  try {
    await conn.beginTransaction();
    const [sessionRows] = await conn.query(
      `SELECT * FROM cash_reconciliation_sessions
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
       FOR UPDATE`,
      [sessionId, orgId],
    );
    const session = sessionRows[0];
    if (!session) throw new NotFoundError('cash_reconciliation_sessions');

    if (session.status !== 'open') {
      throw new ValidationError('Session is not open');
    }

    // Freeze the cash payments in the session window, then sum what was frozen.
    await conn.query(
      `INSERT INTO cash_reconciliation_session_payments (session_id, payment_id, organization_id, amount)
       SELECT ?, id, organization_id, amount
         FROM payments
        WHERE ${SESSION_PAYMENTS} AND created_at BETWEEN ? AND NOW()`,
      [sessionId, orgId, session.agent_user_id, session.opened_at],
    );
    const [sumRows] = await conn.query(
      `SELECT COALESCE(SUM(amount), 0) AS expected_total
         FROM cash_reconciliation_session_payments
        WHERE session_id = ? AND organization_id = ?`,
      [sessionId, orgId],
    );
    const collected = parseFloat(sumRows[0].expected_total);
    // Cash handed to supervisors during the session. One still waiting for
    // the owner would leave the count ambiguous: settle it first.
    const [pickupRows] = await conn.query(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
         FROM cash_reconciliation_pickups
        WHERE organization_id = ? AND session_id = ? AND status IN ('pending', 'confirmed')
        GROUP BY status`,
      [orgId, sessionId],
    );
    const pickups = Object.fromEntries((pickupRows || []).map((r) => [r.status, r]));
    if (pickups.pending && Number(pickups.pending.n) > 0) {
      throw new ValidationError('A cash pickup is waiting for your confirmation; confirm or cancel it before closing');
    }
    const pickupsTotal = round2(pickups.confirmed ? pickups.confirmed.total : 0);
    // What the drawer should hold: the cash stays in it between shifts.
    const opening = round2(session.opening_total || 0);
    expectedTotal = round2(opening + collected - pickupsTotal);
    variance = round2(countedTotal - expectedTotal);

    // A count that matches needs nobody's signature: it is approved on the
    // spot, with no approver (approved_by NULL marks it as automatic). A
    // difference waits for a supervisor, and so does a cashier that was
    // opened with a different amount than it had been closed with.
    const { tolerance } = await rules(orgId, conn.query.bind(conn));
    const openedAsLeft = session.opening_expected === null || session.opening_expected === undefined
      || matches(round2(opening - Number(session.opening_expected)), tolerance);
    matched = matches(variance, tolerance) && openedAsLeft;
    const [result] = await conn.query(
      `UPDATE cash_reconciliation_sessions
         SET expected_total = ?, counted_total = ?, variance = ?, pickups_total = ?,
             status = ?, closed_at = NOW(), approved_at = ${matched ? 'NOW()' : 'NULL'}, approved_by = NULL
       WHERE id = ? AND organization_id = ?`,
      [expectedTotal, countedTotal, variance, pickupsTotal, matched ? 'approved' : 'closed', sessionId, orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('cash_reconciliation_sessions');
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logger.info({ sessionId, expectedTotal, countedTotal, variance, autoApproved: matched }, 'Reconciliation session closed');

  const [updated] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ?',
    [sessionId],
  );
  return updated[0];
}

/**
 * A supervisor's decision on a closed session whose count did not match:
 * approve it (the difference is explained) or dispute it (it is not). Both
 * need a note. Nobody reviews their own cashier, except the company's admin
 * (the owner): with nobody above them, they are the one person who may. Such
 * a review is told apart later by approved_by being the cashier's own owner.
 * A disputed session can still be approved later, once it is settled.
 *
 * @param {{ id: number, role?: string }} reviewer - the signed-in user
 */
async function reviewSession(sessionId, orgId, reviewer, decision, note) {
  const reviewerUserId = reviewer.id;
  const text = String(note || '').trim();
  const [sessionRows] = await db.query(
    `SELECT * FROM cash_reconciliation_sessions
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [sessionId, orgId],
  );
  const session = sessionRows[0];
  if (!session) throw new NotFoundError('cash_reconciliation_sessions');

  const from = decision === 'approved' ? ['closed', 'disputed'] : ['closed'];
  if (!from.includes(session.status)) {
    throw new ValidationError(decision === 'approved'
      ? 'Only a closed or disputed cashier can be approved'
      : 'Only a closed cashier can be disputed');
  }
  const ownCashier = Number(session.agent_user_id) === Number(reviewerUserId);
  if (ownCashier && reviewer.role !== 'admin') {
    throw new AppError('You cannot review your own cashier; another supervisor has to.', 403, 'OWN_CASHIER');
  }
  if (text.length < 3) {
    throw new ValidationError('A note explaining the difference is required');
  }

  const [result] = await db.query(
    `UPDATE cash_reconciliation_sessions
       SET status = ?, approved_by = ?, approved_at = NOW(), review_note = ?
     WHERE id = ? AND organization_id = ? AND status = ?`,
    [decision, reviewerUserId, text.slice(0, 1000), sessionId, orgId, session.status],
  );
  if (result.affectedRows === 0) throw new NotFoundError('cash_reconciliation_sessions');

  logger.info({ sessionId, reviewerUserId, decision, ownCashier }, 'Reconciliation session reviewed');

  const [updated] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [sessionId, orgId],
  );
  return updated[0];
}

const approveSession = (sessionId, orgId, reviewer, note) => reviewSession(sessionId, orgId, reviewer, 'approved', note);
const disputeSession = (sessionId, orgId, reviewer, note) => reviewSession(sessionId, orgId, reviewer, 'disputed', note);

/**
 * The caller's own open cashier, for the reminder shown on every page: when it
 * was opened, what the drawer holds, whether it has been open longer than the
 * organization allows, whether it holds more than the pickup threshold, and
 * any pickup a supervisor recorded that waits for the caller. null when none
 * is open.
 */
async function myOpenSession(orgId, userId) {
  const [rows] = await db.query(
    `SELECT id, agent_user_id, opened_at, opening_total, opening_expected,
            TIMESTAMPDIFF(MINUTE, opened_at, NOW()) AS minutes_open
       FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId, userId],
  );
  const session = rows[0];
  if (!session) return null;
  const { maxOpenHours, pickupThreshold, pickupStrict } = await rules(orgId);
  const state = await drawer(orgId, session);
  const minutes = Number(session.minutes_open) || 0;
  return {
    id: Number(session.id),
    opened_at: session.opened_at,
    hours_open: Math.floor(minutes / 60),
    // The cash the drawer should hold right now.
    expected_total: state.cashOnHand,
    opening_total: state.opening,
    collected_total: state.collected,
    pickups_total: state.handedIn,
    pending_pickups: state.pending,
    pending_pickups_total: state.pendingTotal,
    max_open_hours: maxOpenHours,
    overdue: minutes >= maxOpenHours * 60,
    pickup_threshold: pickupThreshold,
    pickup_strict: pickupStrict,
    over_threshold: pickupThreshold > 0 && toCents(state.cashOnHand) >= toCents(pickupThreshold),
  };
}

/** id → "First Last" for staff users. Staff identities live in the primary database. */
async function staffNames(ids) {
  const unique = [...new Set((ids || []).map(Number).filter(Boolean))];
  const names = new Map();
  if (!unique.length) return names;
  const read = () => db.query(
    `/* org-scoped by: the ids are the owners of this organization's own sessions; staff identities live in the primary database */
     /* includes deleted rows: a cashier left open by someone since removed still names them */
     SELECT id, first_name, last_name FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  try {
    const [rows] = await (typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(read) : read());
    for (const row of rows || []) names.set(Number(row.id), `${row.first_name || ''} ${row.last_name || ''}`.trim());
  } catch (err) {
    logger.warn({ err }, 'Could not read cashier owners\' names');
  }
  return names;
}

/**
 * Set agent_name and approved_by_name on each session row (or the one row):
 * who owns the cashier and who reviewed it. approved_by_name stays null on a
 * count that was approved automatically.
 */
async function addStaffNames(data) {
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const names = await staffNames(rows.flatMap((r) => [r.agent_user_id, r.approved_by]));
  for (const row of rows) {
    if (!('agent_user_id' in row)) continue;
    row.agent_name = names.get(Number(row.agent_user_id)) || null;
    row.approved_by_name = row.approved_by === null || row.approved_by === undefined
      ? null : names.get(Number(row.approved_by)) || null;
  }
}

/**
 * What a supervisor should look at: cashiers left open longer than allowed,
 * cashiers holding more than the pickup threshold, cashiers opened with a
 * different amount than they had been closed with, and closed ones whose
 * count did not match and nobody has reviewed yet.
 */
async function attention(orgId) {
  const { maxOpenHours, pickupThreshold, pickupStrict, tolerance } = await rules(orgId);
  const [open] = await db.query(
    `SELECT s.id, s.agent_user_id, s.opened_at, s.opening_total, s.opening_expected,
            TIMESTAMPDIFF(HOUR, s.opened_at, NOW()) AS hours_open,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
              WHERE p.organization_id = s.organization_id AND p.payment_method = 'cash'
                AND p.recorded_by = s.agent_user_id AND p.status = 'completed' AND p.deleted_at IS NULL
                AND p.created_at >= s.opened_at) AS collected,
            (SELECT COALESCE(SUM(k.amount), 0) FROM cash_reconciliation_pickups k
              WHERE k.organization_id = s.organization_id AND k.session_id = s.id AND k.status = 'confirmed') AS handed_in
       FROM cash_reconciliation_sessions s
      WHERE s.organization_id = ? AND s.status = 'open' AND s.deleted_at IS NULL
      ORDER BY s.opened_at ASC
      LIMIT 100`,
    [orgId],
  );
  const names = await staffNames((open || []).map((r) => r.agent_user_id));
  const [[review]] = await db.query(
    `SELECT COUNT(*) AS n FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND status = 'closed' AND deleted_at IS NULL`,
    [orgId],
  );
  const rows = (open || []).map((r) => {
    const opening = round2(r.opening_total || 0);
    return {
      id: Number(r.id), agent_user_id: Number(r.agent_user_id), agent_name: names.get(Number(r.agent_user_id)) || null,
      opened_at: r.opened_at, hours_open: Number(r.hours_open) || 0,
      cash_on_hand: round2(opening + Number(r.collected) - Number(r.handed_in)),
      opening_difference: r.opening_expected === null || r.opening_expected === undefined
        ? 0 : round2(opening - Number(r.opening_expected)),
    };
  });
  return {
    max_open_hours: maxOpenHours,
    pickup_threshold: pickupThreshold,
    pickup_strict: pickupStrict,
    overdue_open: rows.filter((r) => r.hours_open >= maxOpenHours),
    over_threshold: pickupThreshold > 0 ? rows.filter((r) => toCents(r.cash_on_hand) >= toCents(pickupThreshold)) : [],
    opening_differences: rows.filter((r) => !matches(r.opening_difference, tolerance)),
    awaiting_review: Number(review?.n) || 0,
  };
}

/**
 * Before a person records a cash payment:
 *  - a cashier of theirs left open longer than allowed has to be closed
 *    first, which is what makes the daily count happen;
 *  - when the supervisors have made the pickup threshold strict, a cashier
 *    already holding that much has to hand cash in first. The payment that
 *    crosses the threshold goes through; the next one is refused.
 * Someone with no open cashier is not affected.
 */
async function assertMayTakeCash(orgId, userId) {
  if (userId === null || userId === undefined) return;
  const { maxOpenHours, pickupThreshold, pickupStrict } = await rules(orgId);
  const [rows] = await db.query(
    `SELECT id, agent_user_id, opened_at, opening_total,
            opened_at <= DATE_SUB(NOW(), INTERVAL ? HOUR) AS overdue
       FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [maxOpenHours, orgId, userId],
  );
  const session = rows[0];
  if (!session) return;
  if (Number(session.overdue) === 1) {
    throw new AppError(
      `Your cashier has been open for more than ${maxOpenHours} hours. Close it before recording another cash payment.`,
      409, 'CASHIER_NOT_CLOSED',
    );
  }
  if (pickupStrict && pickupThreshold > 0) {
    const state = await drawer(orgId, session);
    if (toCents(state.cashOnHand) >= toCents(pickupThreshold)) {
      throw new AppError(
        'Your cashier holds the cash limit or more. A supervisor has to pick up cash before you record another cash payment.',
        409, 'CASHIER_OVER_LIMIT',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Cash pickups
// -----------------------------------------------------------------------------

async function openSessionOr404(orgId, sessionId, exec) {
  const [rows] = await exec(
    `SELECT * FROM cash_reconciliation_sessions
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
      FOR UPDATE`,
    [sessionId, orgId],
  );
  if (!rows[0]) throw new NotFoundError('cash_reconciliation_sessions');
  return rows[0];
}

async function inTransaction(work) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn.query.bind(conn));
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function pickupById(orgId, pickupId, exec = db.query.bind(db)) {
  const [rows] = await exec(
    'SELECT * FROM cash_reconciliation_pickups WHERE id = ? AND organization_id = ?',
    [pickupId, orgId],
  );
  return rows[0] || null;
}

/**
 * A supervisor takes cash out of someone's open cashier. It waits for the
 * cashier's owner to confirm it, and counts only then. Nobody takes cash out
 * of their own cashier this way, except the company's admin (the owner), whose
 * pickup is confirmed at once and can be told apart by confirmed_by being the
 * taker.
 *
 * @param {{ id: number, role?: string }} taker - the signed-in supervisor
 */
async function createPickup(orgId, sessionId, taker, amount, note) {
  const value = round2(amount);
  if (!Number.isFinite(value) || value <= 0) throw new ValidationError('The amount picked up must be more than zero');
  const id = await inTransaction(async (exec) => {
    const session = await openSessionOr404(orgId, sessionId, exec);
    if (session.status !== 'open') throw new ValidationError('Cash can only be picked up from an open cashier');
    const own = Number(session.agent_user_id) === Number(taker.id);
    if (own && taker.role !== 'admin') {
      throw new AppError('You cannot pick up cash from your own cashier; another supervisor has to.', 403, 'OWN_CASHIER');
    }
    const state = await drawer(orgId, session, exec);
    const available = round2(state.cashOnHand - state.pendingTotal);
    if (toCents(value) > toCents(available)) {
      throw new ValidationError(`The cashier holds ${available.toFixed(2)}; a pickup cannot be more than that`);
    }
    const [result] = await exec(
      `INSERT INTO cash_reconciliation_pickups
         (organization_id, session_id, amount, status, taken_by, confirmed_by, confirmed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ${own ? 'NOW()' : 'NULL'}, ?)`,
      [orgId, sessionId, value, own ? 'confirmed' : 'pending', taker.id, own ? taker.id : null, String(note || '').trim().slice(0, 500) || null],
    );
    return result.insertId;
  });
  logger.info({ sessionId, pickupId: id, takenBy: taker.id }, 'Cash pickup recorded');
  return pickupById(orgId, id);
}

/** The cashier's owner confirms that the supervisor took that cash. */
async function confirmPickup(orgId, pickupId, userId) {
  await inTransaction(async (exec) => {
    const pickup = await pickupById(orgId, pickupId, exec);
    if (!pickup) throw new NotFoundError('cash_reconciliation_pickups');
    const session = await openSessionOr404(orgId, pickup.session_id, exec);
    if (Number(session.agent_user_id) !== Number(userId)) {
      throw new AppError('Only the owner of the cashier can confirm a pickup from it.', 403, 'NOT_YOUR_CASHIER');
    }
    if (pickup.status !== 'pending') throw new ValidationError('This pickup is no longer waiting for confirmation');
    await exec(
      `UPDATE cash_reconciliation_pickups
          SET status = 'confirmed', confirmed_by = ?, confirmed_at = NOW()
        WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      [userId, pickupId, orgId],
    );
  });
  return pickupById(orgId, pickupId);
}

/**
 * A pickup that did not happen as recorded is cancelled while it still waits:
 * by the cashier's owner (who rejects it) or by the supervisor who recorded it.
 */
async function cancelPickup(orgId, pickupId, userId) {
  await inTransaction(async (exec) => {
    const pickup = await pickupById(orgId, pickupId, exec);
    if (!pickup) throw new NotFoundError('cash_reconciliation_pickups');
    const session = await openSessionOr404(orgId, pickup.session_id, exec);
    if (![Number(session.agent_user_id), Number(pickup.taken_by)].includes(Number(userId))) {
      throw new AppError('Only the owner of the cashier or the supervisor who recorded this pickup can cancel it.', 403, 'NOT_YOUR_PICKUP');
    }
    if (pickup.status !== 'pending') throw new ValidationError('Only a pickup still waiting for confirmation can be cancelled');
    await exec(
      `UPDATE cash_reconciliation_pickups
          SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW()
        WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      [userId, pickupId, orgId],
    );
  });
  return pickupById(orgId, pickupId);
}

/** The pickups of a session, newest first, with who took and who confirmed them. */
async function listPickups(orgId, sessionId) {
  const [rows] = await db.query(
    `SELECT id, session_id, amount, status, taken_by, confirmed_by, confirmed_at, cancelled_at, note, created_at
       FROM cash_reconciliation_pickups
      WHERE organization_id = ? AND session_id = ?
      ORDER BY id DESC`,
    [orgId, sessionId],
  );
  const names = await staffNames((rows || []).flatMap((r) => [r.taken_by, r.confirmed_by]));
  return (rows || []).map((r) => ({
    ...r,
    amount: round2(r.amount),
    taken_by_name: names.get(Number(r.taken_by)) || null,
    confirmed_by_name: r.confirmed_by === null || r.confirmed_by === undefined ? null : names.get(Number(r.confirmed_by)) || null,
  }));
}

/**
 * Get a session with its cash payments included.
 * Returns session + array of cash payments that fall within the session window.
 */
async function getSessionDetail(sessionId, orgId) {
  const [sessionRows] = await db.query(
    `SELECT * FROM cash_reconciliation_sessions
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [sessionId, orgId],
  );
  const session = sessionRows[0];
  if (!session) throw new NotFoundError('cash_reconciliation_sessions');

  // A closed (or approved/disputed) session shows what its close counted:
  // amount is the amount summed then, and status the payment's status now.
  if (session.status !== 'open') {
    const [payments] = await db.query(
      `SELECT p.*, sp.amount AS amount, p.amount AS current_amount
         FROM cash_reconciliation_session_payments sp
         /* includes deleted rows: a payment deleted after the close was still counted by it */
         JOIN payments p ON p.id = sp.payment_id AND p.organization_id = sp.organization_id
        WHERE sp.session_id = ? AND sp.organization_id = ?
        ORDER BY p.created_at ASC, p.id ASC`,
      [sessionId, orgId],
    );
    return { session, payments };
  }

  const [payments] = await db.query(
    `SELECT * FROM payments
     WHERE ${SESSION_PAYMENTS} AND created_at BETWEEN ? AND ?
     ORDER BY created_at ASC`,
    [orgId, session.agent_user_id, session.opened_at, new Date().toISOString()],
  );

  return { session, payments };
}

module.exports = {
  openSession, closeSession, approveSession, disputeSession, getSessionDetail,
  myOpenSession, attention, assertMayTakeCash, rules, setPickupRules, matches, addStaffNames,
  openingExpectation, drawer, createPickup, confirmPickup, cancelPickup, listPickups,
};
