// =============================================================================
// VigaBSS 5.0 — Portal Service Request Service (§11.3)
// =============================================================================
// Handles self-service requests submitted via the client portal:
//   - Plan upgrade/change with proration calculation
//   - Wi-Fi password change (queued via CPE task or ONU OMCI config)
//   - PPPoE password change (synced to RADIUS immediately)
//   - Static IP request
//   - Service cancellation request
//   - Installation/visit scheduling
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const billingService = require('./billingService');
const creditNoteLedgerService = require('./creditNoteLedgerService');

const { calculateProration } = billingService;
const { NotFoundError, ValidationError } = require('../utils/errors');
const { requireOrgId } = require('../utils/requireOrgId');
const { sealSecret } = require('../utils/sealSecrets');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger').child({ service: 'portalServiceRequest' });

// Tenant binding: a client_id match alone is not a tenant boundary
// (ARCHITECTURE.md). Every subscriber-facing query here also binds the portal
// client's organization with the null-safe `<=>` (single-tenant installs store
// NULL organization IDs), and helpers refuse an `undefined` org via
// requireOrgId so a forgotten argument fails loudly instead of unscoping.

// ---------------------------------------------------------------------------
// Create a new service request
// ---------------------------------------------------------------------------

// A requested PPPoE or Wi-Fi password is kept in the payload until approval
// applies it, and every list and detail returned it: to any staff holder of
// portal_service_requests.view, which the read-only role has. Responses carry
// has_new_password instead.
function withoutRequestedPassword(row) {
  if (!row || row.payload === undefined || row.payload === null) return row;
  let payload = row.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return row; }
  }
  if (!payload || typeof payload !== 'object'
      || (!('new_password' in payload) && !('new_password_sealed' in payload))) return row;
  const { new_password: plain, new_password_sealed: sealed, ...rest } = payload;
  return { ...row, payload: { ...rest, has_new_password: Boolean(plain || sealed) } };
}

// A requested Wi-Fi or PPPoE password is kept only until it is applied, and
// only encrypted (SUP-13): the payload carries new_password_sealed, never the
// plaintext, and clearRequestedPassword removes it once the RADIUS change or
// the CPE task has taken it.
function sealRequestedPassword(payload) {
  if (!payload || typeof payload.new_password !== 'string') return payload;
  const { new_password: plain, ...rest } = payload;
  return { ...rest, new_password_sealed: sealSecret(plain) };
}

function requestedPassword(payload) {
  if (!payload) return null;
  if (payload.new_password_sealed) return decrypt(payload.new_password_sealed);
  return payload.new_password || null;
}

async function clearRequestedPassword(requestId) {
  await db.query(
    `UPDATE portal_service_requests
        SET payload = JSON_REMOVE(payload, '$.new_password_sealed', '$.new_password')
      WHERE id = ? AND JSON_VALID(payload)`,
    [requestId],
  );
}

/** Active plans of the organization, or global ones (TNB-11). */
async function findUpgradePlan(planId, organizationId, executor = db) {
  const [plans] = await executor.query(
    `SELECT id, name, price FROM plans
     WHERE id = ? AND (organization_id <=> ? OR organization_id IS NULL)
       AND status = 'active' AND deleted_at IS NULL`,
    [planId, organizationId],
  );
  return plans;
}

/**
 * Plans a subscriber may ask to move to: the same active org/global plans
 * findUpgradePlan accepts, minus the plan the active contract is already on.
 * Backs the portal's plan picker, which replaced a free-text plan id (BIL-23).
 */
async function listUpgradePlans(clientId, organizationId) {
  requireOrgId(organizationId, 'portalServiceRequestService.listUpgradePlans');
  const [rows] = await db.query(
    `SELECT p.id, p.name, p.price, p.currency, p.billing_cycle,
            p.download_speed_mbps, p.upload_speed_mbps
       FROM plans p
      WHERE (p.organization_id <=> ? OR p.organization_id IS NULL)
        AND p.status = 'active' AND p.deleted_at IS NULL
        AND p.id NOT IN (
          SELECT c.plan_id FROM contracts c
           WHERE c.client_id = ? AND c.organization_id <=> ? AND c.status = 'active' AND c.deleted_at IS NULL
        )
      ORDER BY p.price, p.name`,
    [organizationId, clientId, organizationId],
  );
  return rows;
}

// Printable ASCII without spaces. Wi-Fi follows the WPA2 passphrase rule
// (8-63 characters); PPPoE secrets are written into RADIUS and router
// commands as given, so they get the same charset (TNB-11).
const REQUESTED_PASSWORD = /^[\x21-\x7E]+$/;
function assertRequestedPassword(requestType, value) {
  const max = requestType === 'wifi_password_change' ? 63 : 64;
  if (typeof value !== 'string' || value.length < 8 || value.length > max || !REQUESTED_PASSWORD.test(value)) {
    throw new ValidationError(`new_password must be 8-${max} printable characters without spaces`, [{
      field: 'payload.new_password',
      message: `8-${max} printable ASCII characters, no spaces`,
    }]);
  }
}

/**
 * @param {object} opts
 * @param {number} opts.clientId
 * @param {number} opts.organizationId
 * @param {string} opts.requestType
 * @param {object} [opts.payload]
 * @returns {Promise<object>} The created request row
 */
async function createRequest({ clientId, organizationId, requestType, payload = {} }) {
  requireOrgId(organizationId, 'portalServiceRequestService.createRequest');
  // Resolve the client's active contract — in the client's own organization.
  const [contracts] = await db.query(
    `SELECT c.id, c.plan_id, c.status, c.start_date,
            p.name AS plan_name, p.price, p.billing_cycle
     FROM contracts c
     JOIN plans p ON p.id = c.plan_id
     WHERE c.client_id = ? AND c.organization_id <=> ? AND c.status = 'active' AND c.deleted_at IS NULL
     LIMIT 1`,
    [clientId, organizationId],
  );
  const contract = contracts[0] || null;

  let prorationCredit = null;
  let prorationCharge = null;
  let prorationNet = null;

  // For plan upgrades calculate proration up-front
  if (requestType === 'plan_upgrade') {
    const { new_plan_id } = payload;
    if (!new_plan_id) throw new ValidationError('new_plan_id is required for plan_upgrade');
    if (!contract) throw new ValidationError('No active contract found for this client');

    // The target plan must be an active plan of this organization or a
    // global (organization_id IS NULL) one. A foreign, inactive or archived
    // plan reads as missing (TNB-11); approval checks it again.
    const plans = await findUpgradePlan(new_plan_id, organizationId);
    if (!plans[0]) throw new NotFoundError('Plan');
    if (plans[0].id === contract.plan_id) {
      throw new ValidationError('Client is already on this plan');
    }

    // Find the current billing period. invoices has no period_start/
    // period_end columns — those live on billing_periods; the most recent
    // 'invoiced' period is the one the customer is actually being charged for
    // (the nearest equivalent of "an invoice exists for this period").
    const [periods] = await db.query(
      `SELECT period_start, period_end FROM billing_periods
       WHERE contract_id = ? AND status = 'invoiced'
       ORDER BY period_start DESC LIMIT 1`,
      [contract.id],
    );

    if (periods[0]) {
      const proration = calculateProration({
        oldPrice: contract.price,
        newPrice: plans[0].price,
        changeDate: new Date(),
        periodStart: periods[0].period_start,
        periodEnd: periods[0].period_end,
      });
      prorationCredit = proration.credit;
      prorationCharge = proration.charge;
      prorationNet = proration.net;
    }

    payload.new_plan_name = plans[0].name;
    payload.new_plan_price = plans[0].price;
    payload.current_plan_id = contract.plan_id;
    payload.current_plan_name = contract.plan_name;
  }

  if (requestType === 'pppoe_password_change' || requestType === 'wifi_password_change') {
    assertRequestedPassword(requestType, payload.new_password);
  }

  // Validate PPPoE password change has a radius account
  if (requestType === 'pppoe_password_change') {
    if (!contract) throw new ValidationError('No active contract found for this client');
    const [radRows] = await db.query(
      'SELECT id FROM radius WHERE contract_id = ? AND deleted_at IS NULL LIMIT 1',
      [contract.id],
    );
    if (!radRows[0]) {
      throw new ValidationError('No PPPoE account found for this contract');
    }
  }

  const contractId = contract ? contract.id : null;

  const [result] = await db.query(
    `INSERT INTO portal_service_requests
       (organization_id, client_id, contract_id, request_type, status, payload,
        proration_credit, proration_charge, proration_net)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      organizationId,
      clientId,
      contractId,
      requestType,
      JSON.stringify(sealRequestedPassword(payload)),
      prorationCredit,
      prorationCharge,
      prorationNet,
    ],
  );

  logger.info({ requestId: result.insertId, clientId, requestType }, 'Portal service request created');

  const [rows] = await db.query(
    'SELECT * FROM portal_service_requests WHERE id = ?',
    [result.insertId],
  );
  return withoutRequestedPassword(rows[0]);
}

// ---------------------------------------------------------------------------
// Get requests for a client
// ---------------------------------------------------------------------------

async function listRequests(clientId, organizationId, { page = 1, limit = 20, requestType } = {}) {
  requireOrgId(organizationId, 'portalServiceRequestService.listRequests');
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 500);
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeOffset = (safePage - 1) * safeLimit;
  let where = 'WHERE client_id = ? AND organization_id <=> ? AND deleted_at IS NULL';
  const params = [clientId, organizationId];

  if (requestType) {
    where += ' AND request_type = ?';
    params.push(requestType);
  }

  const [rows] = await db.query(
    `SELECT id, request_type, status, payload, notes,
            proration_credit, proration_charge, proration_net,
            approved_at, completed_at, cancelled_at, created_at, updated_at
     FROM portal_service_requests ${where}
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM portal_service_requests ${where}`,
    params,
  );
  return { rows: rows.map(withoutRequestedPassword), total };
}

// ---------------------------------------------------------------------------
// Cancel a pending request (client-side)
// ---------------------------------------------------------------------------

async function cancelRequest(requestId, clientId, organizationId) {
  requireOrgId(organizationId, 'portalServiceRequestService.cancelRequest');
  const [rows] = await db.query(
    `SELECT id, status FROM portal_service_requests
     WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL`,
    [requestId, clientId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('Service request');
  if (rows[0].status !== 'pending') {
    throw new ValidationError('Only pending requests can be cancelled');
  }
  // The write repeats the ownership and pending predicates so it can never
  // touch a row other than the one just checked.
  await db.query(
    `UPDATE portal_service_requests
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE id = ? AND client_id = ? AND organization_id <=> ? AND status = 'pending'`,
    [requestId, clientId, organizationId],
  );
  return { id: requestId, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Apply an approved PPPoE password change to RADIUS
// ---------------------------------------------------------------------------

async function applyPppoePasswordChange(requestId) {
  const [rows] = await db.query(
    'SELECT * FROM portal_service_requests WHERE id = ? AND deleted_at IS NULL',
    [requestId],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError('Service request');

  const payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : req.payload;
  const newPassword = requestedPassword(payload);
  if (!newPassword) throw new ValidationError('No new_password in request payload');

  // Update radius account password
  await db.query(
    'UPDATE radius SET password = ?, updated_at = NOW() WHERE contract_id = ?',
    [newPassword, req.contract_id],
  );

  await db.query(
    `UPDATE portal_service_requests
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [requestId],
  );

  await clearRequestedPassword(requestId);
  logger.info({ requestId, contractId: req.contract_id }, 'PPPoE password updated via portal request');
}

/**
 * Queue the TR-069 CPE task that sets a contract's Wi-Fi PreSharedKey. Shared by
 * the admin approve path and the WhatsApp self-service reset. Returns
 * { queued } — false when the contract has no managed CPE device (the caller
 * then leaves the change for manual fulfillment).
 */
async function queueWifiPasswordCpeTask({ organizationId, contractId, newPassword, createdBy = null }) {
  requireOrgId(organizationId, 'portalServiceRequestService.queueWifiPasswordCpeTask');
  if (!contractId || !newPassword) return { queued: false };
  // Only a CPE in the request's own organization may receive the new PSK.
  const [cpeRows] = await db.query(
    `SELECT id, organization_id FROM cpe_devices
     WHERE contract_id = ? AND organization_id <=> ? AND deleted_at IS NULL LIMIT 1`,
    [contractId, organizationId],
  );
  if (!cpeRows[0]) return { queued: false };
  const CpeTask = require('../models/CpeTask');
  const task = await CpeTask.create({
    organization_id: cpeRows[0].organization_id,
    cpe_device_id: cpeRows[0].id,
    task_type: 'set_parameter_values',
    parameters: JSON.stringify([
      {
        name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
        value: newPassword,
        type: 'xsd:string',
      },
    ]),
    priority: 3,
    status: 'queued',
    created_by: createdBy,
  });
  return { queued: true, taskId: task?.id ?? null };
}

/**
 * Link a Wi-Fi password request to the CPE task that applies it. The request
 * stays 'approved' until the router confirms (settleWifiRequestForTask): it
 * used to turn 'completed' as soon as the task was queued (NET-12).
 */
async function linkWifiRequestToTask(requestId, taskId) {
  await db.query(
    `UPDATE portal_service_requests
        SET status = 'approved', payload = JSON_SET(COALESCE(payload, JSON_OBJECT()), '$.cpe_task_id', ?), updated_at = NOW()
      WHERE id = ? AND status IN ('pending', 'approved')`,
    [taskId, requestId],
  );
}

/**
 * The router answered the Wi-Fi task: complete the request it applies, or
 * record why it did not apply (the request stays 'approved' for staff).
 */
async function settleWifiRequestForTask(taskId, applied, error = null) {
  if (applied) {
    await db.query(
      `UPDATE portal_service_requests
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE request_type = 'wifi_password_change' AND status = 'approved'
          AND JSON_EXTRACT(payload, '$.cpe_task_id') = ?`,
      [taskId],
    );
    return;
  }
  await db.query(
    `UPDATE portal_service_requests
        SET payload = JSON_SET(payload, '$.cpe_error', ?), updated_at = NOW()
      WHERE request_type = 'wifi_password_change' AND status = 'approved'
        AND JSON_EXTRACT(payload, '$.cpe_task_id') = ?`,
    [String(error || 'the router refused the change').slice(0, 500), taskId],
  );
}

// ---------------------------------------------------------------------------
// Admin: list requests across all clients (with filters)
// ---------------------------------------------------------------------------

/**
 * @param {number} organizationId
 * @param {{ page?, limit?, status?, requestType?, clientId? }} opts
 */
async function adminListRequests(organizationId, { page = 1, limit = 25, status, requestType, clientId } = {}) {
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 25), 500);
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeOffset = (safePage - 1) * safeLimit;
  let where = 'WHERE psr.organization_id = ? AND psr.deleted_at IS NULL';
  const params = [organizationId];

  if (status) {
    where += ' AND psr.status = ?';
    params.push(status);
  }
  if (requestType) {
    where += ' AND psr.request_type = ?';
    params.push(requestType);
  }
  if (clientId) {
    where += ' AND psr.client_id = ?';
    params.push(clientId);
  }

  const [rows] = await db.query(
    `SELECT psr.id, psr.client_id, psr.contract_id, psr.request_type, psr.status,
            psr.payload, psr.notes, psr.approved_by, psr.approved_at,
            psr.completed_at, psr.cancelled_at,
            psr.proration_credit, psr.proration_charge, psr.proration_net,
            psr.created_at, psr.updated_at,
            cl.name AS client_name,
            cl.email AS client_email
     FROM portal_service_requests psr
     LEFT JOIN clients cl ON cl.id = psr.client_id
     ${where}
     ORDER BY psr.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM portal_service_requests psr ${where}`,
    params,
  );
  return { rows: rows.map(withoutRequestedPassword), total };
}

/**
 * Admin: get a single request by id with org scoping.
 */
async function adminGetRequest(requestId, organizationId) {
  const [rows] = await db.query(
    `SELECT psr.*, cl.name AS client_name, cl.email AS client_email
     FROM portal_service_requests psr
     LEFT JOIN clients cl ON cl.id = psr.client_id
     WHERE psr.id = ? AND psr.organization_id = ? AND psr.deleted_at IS NULL`,
    [requestId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('Service request');
  return withoutRequestedPassword(rows[0]);
}

/**
 * Admin: approve a request and execute the corresponding action.
 * @param {number} requestId
 * @param {number} organizationId
 * @param {number} approvedByUserId
 * @param {string} [notes]
 */
async function approveRequest(requestId, organizationId, approvedByUserId, notes) {
  const [rows] = await db.query(
    'SELECT * FROM portal_service_requests WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [requestId, organizationId],
  );
  const req = rows[0];
  if (!req) throw new NotFoundError('Service request');
  if (req.status !== 'pending') {
    throw new ValidationError(`Request is already ${req.status}`);
  }

  const payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : (req.payload || {});

  // The plan was checked when the subscriber asked; it may since have been
  // archived, and requests stored before that check could name any
  // organization's plan (TNB-11). The request stays pending if it fails.
  if (req.request_type === 'plan_upgrade' && payload.new_plan_id) {
    const plans = await findUpgradePlan(payload.new_plan_id, organizationId);
    if (!plans[0]) {
      throw new ValidationError('The requested plan is no longer available to this organization; reject the request instead');
    }
  }

  if (req.request_type === 'plan_upgrade') {
    await approvePlanUpgrade(req, payload, organizationId, approvedByUserId, notes);
    const [done] = await db.query('SELECT * FROM portal_service_requests WHERE id = ?', [requestId]);
    return withoutRequestedPassword(done[0]);
  }

  // Set approved_by + approved_at, only from pending, so two approvals
  // cannot both run the action.
  const [approved] = await db.query(
    `UPDATE portal_service_requests
     SET status = 'approved', approved_by = ?, approved_at = NOW(),
         notes = COALESCE(?, notes), updated_at = NOW()
     WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    [approvedByUserId, notes || null, requestId, organizationId],
  );
  if (!approved.affectedRows) throw new ValidationError('Request is no longer pending');

  // Execute type-specific action
  if (req.request_type === 'pppoe_password_change') {
    // Apply RADIUS password change and mark completed
    await applyPppoePasswordChange(requestId);
  } else if (req.request_type === 'wifi_password_change') {
    // Queue a CPE set-parameter task for the Wi-Fi password if we can resolve the
    // device; if no CPE device is found, leave as approved for manual fulfillment.
    const { queued, taskId } = await queueWifiPasswordCpeTask({
      organizationId,
      contractId: req.contract_id,
      newPassword: requestedPassword(payload),
      createdBy: approvedByUserId,
    });
    if (queued) {
      await clearRequestedPassword(requestId);
      // Completed once the router confirms the change, not when queued.
      await linkWifiRequestToTask(requestId, taskId);
      logger.info({ requestId, taskId }, 'Wi-Fi password change queued via CPE task');
    }
  } else {
    // static_ip_request, cancellation, visit_schedule — approved, manual fulfillment
    // Status stays 'approved'; admin calls POST /:id/complete when done
  }

  const [updated] = await db.query(
    'SELECT * FROM portal_service_requests WHERE id = ?',
    [requestId],
  );
  return withoutRequestedPassword(updated[0]);
}

/**
 * Approve a plan change: switch the contract's plan and bill the proration
 * stored when the subscriber asked, all in one transaction with the
 * pending -> completed transition (BIL-23). A positive net raises a one-off
 * invoice for the remaining days at the new price; a negative net issues a
 * credit note for the unused days of the old one. A failure rolls everything
 * back and leaves the request pending.
 */
async function approvePlanUpgrade(req, payload, organizationId, approvedByUserId, notes) {
  const net = req.proration_net === null || req.proration_net === undefined
    ? 0 : Math.round(parseFloat(req.proration_net) * 100) / 100;
  const description = `Plan change proration: ${payload.current_plan_name || payload.current_plan_id || 'previous plan'}`
    + ` -> ${payload.new_plan_name || payload.new_plan_id}`;

  const conn = await db.getConnection();
  let invoice = null;
  let creditNoteId = null;
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);

    const [approved] = await exec(
      `UPDATE portal_service_requests
       SET status = 'completed', approved_by = ?, approved_at = NOW(), completed_at = NOW(),
           notes = COALESCE(?, notes), updated_at = NOW()
       WHERE id = ? AND organization_id = ? AND status = 'pending'`,
      [approvedByUserId, notes || null, req.id, organizationId],
    );
    if (!approved.affectedRows) throw new ValidationError('Request is no longer pending');

    if (req.contract_id && payload.new_plan_id) {
      await exec(
        'UPDATE contracts SET plan_id = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?',
        [payload.new_plan_id, req.contract_id, organizationId],
      );
    }

    if (net > 0) {
      invoice = await billingService.createOneOffInvoice({
        orgId: organizationId, clientId: req.client_id, contractId: req.contract_id,
        description, amount: net, conn,
      });
    } else if (net < 0) {
      creditNoteId = await issueProrationCreditNote(exec, req, organizationId, -net, description, approvedByUserId);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  if (invoice) await require('./businessEvents').emitInvoiceCreated(organizationId, invoice);
  logger.info({
    requestId: req.id, contractId: req.contract_id, newPlanId: payload.new_plan_id,
    prorationNet: net, invoiceId: invoice?.id ?? null, creditNoteId,
  }, 'Plan upgrade applied via portal request');
}

/** An issued credit note for a downgrade's unused days, posted to the ledger. */
async function issueProrationCreditNote(exec, req, organizationId, amount, description, createdBy) {
  const tax = await billingService.resolveTaxContext(exec, { orgId: organizationId, clientId: req.client_id });
  const subtotal = Math.round(amount * 100) / 100;
  const taxAmount = Math.round(subtotal * tax.rate * 100) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  const currency = await require('../models/Organization').getCurrency(organizationId);
  const number = `PCN-${req.id}`;

  const [result] = await exec(
    `INSERT INTO credit_notes
       (organization_id, client_id, contract_id, credit_note_number, issue_date, reason,
        subtotal, tax_rate, tax_amount, total, currency, tax_rate_id, notes, status, created_by)
     VALUES (?, ?, ?, ?, CURDATE(), 'other', ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
    [organizationId, req.client_id, req.contract_id || null, number, subtotal, tax.rate, taxAmount,
      total, currency, tax.taxRateId || null, description, createdBy || null],
  );
  await creditNoteLedgerService.syncCreditNoteLedger(exec, {
    id: result.insertId, client_id: req.client_id, credit_note_number: number,
    total, currency, status: 'issued',
  }, organizationId);
  return result.insertId;
}

/**
 * Admin: mark an approved request as completed (manual fulfillment).
 */
async function completeRequest(requestId, organizationId) {
  const [rows] = await db.query(
    'SELECT id, status FROM portal_service_requests WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [requestId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('Service request');
  if (rows[0].status !== 'approved') {
    throw new ValidationError('Only approved requests can be marked completed');
  }
  await db.query(
    `UPDATE portal_service_requests
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [requestId],
  );
  return { id: requestId, status: 'completed' };
}

/**
 * Admin: reject a pending request with notes.
 */
async function rejectRequest(requestId, organizationId, notes) {
  const [rows] = await db.query(
    'SELECT id, status FROM portal_service_requests WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [requestId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('Service request');
  if (rows[0].status !== 'pending') {
    throw new ValidationError(`Request is already ${rows[0].status}`);
  }
  await db.query(
    `UPDATE portal_service_requests
     SET status = 'rejected', notes = ?, updated_at = NOW()
     WHERE id = ?`,
    [notes || null, requestId],
  );
  return { id: requestId, status: 'rejected' };
}

// ---------------------------------------------------------------------------
// Create a push subscription (Web Push)
// ---------------------------------------------------------------------------

async function upsertPushSubscription({
  clientId,
  organizationId,
  endpoint,
  p256dh,
  auth,
  userAgent,
  notifyOutage,
  notifyBilling,
  notifyTicket,
}) {
  requireOrgId(organizationId, 'portalServiceRequestService.upsertPushSubscription');
  // Check if this endpoint already exists for this client in its own org; a
  // foreign-org row naming the same client_id is never updated in place.
  const [existing] = await db.query(
    `SELECT id FROM portal_push_subscriptions
     WHERE client_id = ? AND organization_id <=> ? AND endpoint = ? AND deleted_at IS NULL`,
    [clientId, organizationId, endpoint],
  );

  if (existing[0]) {
    // Build dynamic SET clause — only update notify_* when explicitly provided
    const setClauses = ['p256dh = ?', 'auth = ?', 'user_agent = ?'];
    const params = [p256dh, auth, userAgent || null];

    if (notifyOutage !== undefined && notifyOutage !== null) {
      setClauses.push('notify_outage = ?');
      params.push(notifyOutage ? 1 : 0);
    }
    if (notifyBilling !== undefined && notifyBilling !== null) {
      setClauses.push('notify_billing = ?');
      params.push(notifyBilling ? 1 : 0);
    }
    if (notifyTicket !== undefined && notifyTicket !== null) {
      setClauses.push('notify_ticket = ?');
      params.push(notifyTicket ? 1 : 0);
    }

    setClauses.push('updated_at = NOW()');
    params.push(existing[0].id);

    await db.query(
      `UPDATE portal_push_subscriptions SET ${setClauses.join(', ')} WHERE id = ?`,
      params,
    );
    return { id: existing[0].id, updated: true };
  }

  const [result] = await db.query(
    `INSERT INTO portal_push_subscriptions
       (organization_id, client_id, endpoint, p256dh, auth, user_agent,
        notify_outage, notify_billing, notify_ticket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      organizationId,
      clientId,
      endpoint,
      p256dh,
      auth,
      userAgent || null,
      notifyOutage !== undefined && notifyOutage !== null ? (notifyOutage ? 1 : 0) : 1,
      notifyBilling !== undefined && notifyBilling !== null ? (notifyBilling ? 1 : 0) : 1,
      notifyTicket !== undefined && notifyTicket !== null ? (notifyTicket ? 1 : 0) : 1,
    ],
  );
  return { id: result.insertId, updated: false };
}

async function deletePushSubscription(clientId, organizationId, endpoint) {
  requireOrgId(organizationId, 'portalServiceRequestService.deletePushSubscription');
  await db.query(
    `UPDATE portal_push_subscriptions
     SET deleted_at = NOW()
     WHERE client_id = ? AND organization_id <=> ? AND endpoint = ? AND deleted_at IS NULL`,
    [clientId, organizationId, endpoint],
  );
}

// ---------------------------------------------------------------------------
// Generate a portal chat session token
// ---------------------------------------------------------------------------

function generateChatToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Knowledge base helpers (public read + portal search)
// ---------------------------------------------------------------------------

async function listKbArticles(organizationId, { category, search, page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 20), 500);
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeOffset = (safePage - 1) * safeLimit;
  let where = 'WHERE (organization_id = ? OR organization_id IS NULL) AND is_published = 1 AND deleted_at IS NULL';
  const params = [organizationId];

  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }
  if (search) {
    where += ' AND (title LIKE ? OR body LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const [rows] = await db.query(
    `SELECT id, category, title, slug, view_count, helpful_yes, helpful_no, created_at, updated_at
     FROM portal_kb_articles ${where}
     ORDER BY view_count DESC, updated_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  );
  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM portal_kb_articles ${where}`,
    params,
  );
  return { rows, total };
}

async function getKbArticle(organizationId, slugOrId) {
  const field = isNaN(Number(slugOrId)) ? 'slug' : 'id';
  const [rows] = await db.query(
    `SELECT id, category, title, slug, body, view_count, helpful_yes, helpful_no, created_at, updated_at
     FROM portal_kb_articles
     WHERE ${field} = ?
       AND (organization_id = ? OR organization_id IS NULL)
       AND is_published = 1
       AND deleted_at IS NULL`,
    [slugOrId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('KB article');
  // Increment view count (fire-and-forget)
  db.query('UPDATE portal_kb_articles SET view_count = view_count + 1 WHERE id = ?', [rows[0].id]);
  return rows[0];
}

async function rateKbArticle(organizationId, slugOrId, helpful) {
  const field = isNaN(Number(slugOrId)) ? 'slug' : 'id';
  const col = helpful ? 'helpful_yes' : 'helpful_no';
  const [rows] = await db.query(
    `SELECT id FROM portal_kb_articles
     WHERE ${field} = ?
       AND (organization_id = ? OR organization_id IS NULL)
       AND is_published = 1
       AND deleted_at IS NULL`,
    [slugOrId, organizationId],
  );
  if (!rows[0]) throw new NotFoundError('KB article');
  await db.query(
    `UPDATE portal_kb_articles SET ${col} = ${col} + 1 WHERE id = ?`,
    [rows[0].id],
  );
  return { id: rows[0].id, rated: helpful ? 'yes' : 'no' };
}

module.exports = {
  listUpgradePlans,
  sealRequestedPassword,
  clearRequestedPassword,
  linkWifiRequestToTask,
  settleWifiRequestForTask,
  createRequest,
  listRequests,
  cancelRequest,
  applyPppoePasswordChange,
  queueWifiPasswordCpeTask,
  adminListRequests,
  adminGetRequest,
  approveRequest,
  rejectRequest,
  completeRequest,
  upsertPushSubscription,
  deletePushSubscription,
  generateChatToken,
  listKbArticles,
  getKbArticle,
  rateKbArticle,
};
