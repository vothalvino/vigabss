// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation Service
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'cashReconciliation' });
const { NotFoundError, ValidationError } = require('../utils/errors');

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

    const [result] = await conn.query(
      `UPDATE cash_reconciliation_sessions
         SET expected_total = ?, counted_total = ?, variance = ?,
             status = 'closed', closed_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [expectedTotal, countedTotal, variance, sessionId, orgId],
    );
    if (result.affectedRows === 0) throw new NotFoundError('cash_reconciliation_sessions');
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logger.info({ sessionId, expectedTotal, countedTotal, variance }, 'Reconciliation session closed');

  const [updated] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ?',
    [sessionId],
  );
  return updated[0];
}

/**
 * Approve a session (supervisor action).
 */
async function approveSession(sessionId, orgId, approverUserId) {
  const [sessionRows] = await db.query(
    `SELECT * FROM cash_reconciliation_sessions
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [sessionId, orgId],
  );
  const session = sessionRows[0];
  if (!session) throw new NotFoundError('cash_reconciliation_sessions');

  if (session.status !== 'closed') {
    throw new ValidationError('Session must be closed before it can be approved');
  }

  const [result] = await db.query(
    `UPDATE cash_reconciliation_sessions
       SET status = 'approved', approved_by = ?, approved_at = NOW()
     WHERE id = ? AND organization_id = ?`,
    [approverUserId, sessionId, orgId],
  );

  if (result.affectedRows === 0) throw new NotFoundError('cash_reconciliation_sessions');

  logger.info({ sessionId, approverUserId }, 'Reconciliation session approved');

  const [updated] = await db.query(
    'SELECT * FROM cash_reconciliation_sessions WHERE id = ?',
    [sessionId],
  );
  return updated[0];
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

module.exports = { openSession, closeSession, approveSession, getSessionDetail };
