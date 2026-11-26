// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Service
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'cashReconciliation' });
const { NotFoundError, ValidationError, AppError } = require('../utils/errors');
const { ORG_SETTING_DEFS } = require('./settingsCatalog');

/**
 * The organization's cashier rules (Settings): how large a difference still
 * counts as a match, and how long a cashier may stay open.
 */
async function rules(orgId, exec = db.query.bind(db)) {
  const keys = ['cashier_match_tolerance', 'cashier_max_open_hours'];
  const values = Object.fromEntries(keys.map((k) => [k, ORG_SETTING_DEFS[k].default]));
  const [rows] = await exec(
    `SELECT setting_key, setting_value FROM organization_settings
      WHERE organization_id = ? AND setting_key IN (?, ?)`,
    [orgId, ...keys],
  );
  for (const row of rows || []) {
    // A stored value the catalog would refuse today falls back to the default.
    if (ORG_SETTING_DEFS[row.setting_key].validate(String(row.setting_value)) === null) values[row.setting_key] = row.setting_value;
  }
  return { tolerance: Number(values.cashier_match_tolerance), maxOpenHours: Number(values.cashier_max_open_hours) };
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
 * Open a new reconciliation session for an agent.
 * Agent must not already have an open session for the same org.
 */
async function openSession({ organizationId, agentUserId, notes }) {
  // Check for an existing open session
  const [existing] = await db.query(
    `SELECT id FROM cash_reconciliation_sessions
     WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL`,
    [organizationId, agentUserId],
  );
  if (existing.length > 0) {
    throw new ValidationError('Agent already has an open reconciliation session');
  }

  const [result] = await db.query(
    `INSERT INTO cash_reconciliation_sessions
       (organization_id, agent_user_id, opened_at, status, notes)
     VALUES (?, ?, NOW(), 'open', ?)`,
    [organizationId, agentUserId, notes || null],
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
 * window, sum them into expected_total, and set variance = counted_total -
 * expected_total. The frozen list (migration 521) is what the closed
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
    expectedTotal = parseFloat(sumRows[0].expected_total);
    variance = Math.round((countedTotal - expectedTotal) * 100) / 100;

    // A count that matches needs nobody's signature: it is approved on the
    // spot, with no approver (approved_by NULL marks it as automatic). A
    // difference waits for a supervisor.
    const { tolerance } = await rules(orgId, conn.query.bind(conn));
    matched = matches(variance, tolerance);
    const [result] = await conn.query(
      `UPDATE cash_reconciliation_sessions
         SET expected_total = ?, counted_total = ?, variance = ?,
             status = ?, closed_at = NOW(), approved_at = ${matched ? 'NOW()' : 'NULL'}, approved_by = NULL
       WHERE id = ? AND organization_id = ?`,
      [expectedTotal, countedTotal, variance, matched ? 'approved' : 'closed', sessionId, orgId],
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
 * need a note, and neither can be made by the person whose cashier it is.
 * A disputed session can still be approved later, once it is settled.
 */
async function reviewSession(sessionId, orgId, reviewerUserId, decision, note) {
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
  if (Number(session.agent_user_id) === Number(reviewerUserId)) {
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

  logger.info({ sessionId, reviewerUserId, decision }, 'Reconciliation session reviewed');

  const [updated] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ?',
    [sessionId],
  );
  return updated[0];
}

const approveSession = (sessionId, orgId, userId, note) => reviewSession(sessionId, orgId, userId, 'approved', note);
const disputeSession = (sessionId, orgId, userId, note) => reviewSession(sessionId, orgId, userId, 'disputed', note);

/**
 * The caller's own open cashier, for the reminder shown on every page: when it
 * was opened, the cash recorded in it so far, and whether it has been open
 * longer than the organization allows. null when none is open.
 */
async function myOpenSession(orgId, userId) {
  const [rows] = await db.query(
    `SELECT id, opened_at, TIMESTAMPDIFF(MINUTE, opened_at, NOW()) AS minutes_open
       FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId, userId],
  );
  const session = rows[0];
  if (!session) return null;
  const { maxOpenHours } = await rules(orgId);
  const [sumRows] = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS expected_total FROM payments
      WHERE ${SESSION_PAYMENTS} AND created_at BETWEEN ? AND NOW()`,
    [orgId, userId, session.opened_at],
  );
  const minutes = Number(session.minutes_open) || 0;
  return {
    id: Number(session.id),
    opened_at: session.opened_at,
    hours_open: Math.floor(minutes / 60),
    expected_total: Number(sumRows[0].expected_total),
    max_open_hours: maxOpenHours,
    overdue: minutes >= maxOpenHours * 60,
  };
}

/** id → "First Last" for staff users. Staff identities live in the primary database. */
async function staffNames(ids) {
  const unique = [...new Set((ids || []).map(Number).filter(Boolean))];
  const names = new Map();
  if (!unique.length) return names;
  const read = () => db.query(
    `SELECT id, first_name, last_name FROM users WHERE id IN (${unique.map(() => '?').join(', ')})`,
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
 * What a supervisor should look at: cashiers left open longer than allowed,
 * and closed ones whose count did not match and nobody has reviewed yet.
 */
async function attention(orgId) {
  const { maxOpenHours } = await rules(orgId);
  const [open] = await db.query(
    `SELECT id, agent_user_id, opened_at, TIMESTAMPDIFF(HOUR, opened_at, NOW()) AS hours_open
       FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND status = 'open' AND deleted_at IS NULL
        AND opened_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
      ORDER BY opened_at ASC
      LIMIT 50`,
    [orgId, maxOpenHours],
  );
  const names = await staffNames((open || []).map((r) => r.agent_user_id));
  const [[review]] = await db.query(
    `SELECT COUNT(*) AS n FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND status = 'closed' AND deleted_at IS NULL`,
    [orgId],
  );
  return {
    max_open_hours: maxOpenHours,
    overdue_open: (open || []).map((r) => ({
      id: Number(r.id), agent_user_id: Number(r.agent_user_id), agent_name: names.get(Number(r.agent_user_id)) || null,
      opened_at: r.opened_at, hours_open: Number(r.hours_open) || 0,
    })),
    awaiting_review: Number(review?.n) || 0,
  };
}

/**
 * Before a person records a cash payment: a cashier of theirs left open
 * longer than allowed has to be closed first. This is what makes the daily
 * count happen; someone with no open cashier is not affected.
 */
async function assertCashierNotOverdue(orgId, userId) {
  if (userId === null || userId === undefined) return;
  const { maxOpenHours } = await rules(orgId);
  const [rows] = await db.query(
    `SELECT id FROM cash_reconciliation_sessions
      WHERE organization_id = ? AND agent_user_id = ? AND status = 'open' AND deleted_at IS NULL
        AND opened_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
      LIMIT 1`,
    [orgId, userId, maxOpenHours],
  );
  if (rows[0]) {
    throw new AppError(
      `Your cashier has been open for more than ${maxOpenHours} hours. Close it before recording another cash payment.`,
      409, 'CASHIER_NOT_CLOSED',
    );
  }
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
  myOpenSession, attention, assertCashierNotOverdue, rules, matches,
};
