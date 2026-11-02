// =============================================================================
// VigaBSS 5.0 — Client Self-Service Portal Routes
// =============================================================================
// All routes are prefixed /api/v1/portal.
//
// Public (unauthenticated):
//   POST   /portal/auth/login
//   POST   /portal/auth/refresh
//   POST   /portal/auth/logout
//   POST   /portal/auth/password-reset/request  request a password reset email
//   POST   /portal/auth/password-reset          redeem a reset token for a new password
//
// Authenticated (requires portal JWT):
//   GET    /portal/auth/me
//   PUT    /portal/auth/password
//
//   --- §11.1 Dashboard ---
//   GET    /portal/dashboard            account overview (plan, balance, session)
//   GET    /portal/usage/current-month  daily usage data for current billing month
//
//   --- §11.2 Billing & Payments ---
//   GET    /portal/invoices             list own invoices
//   GET    /portal/invoices/:id         invoice detail + line items
//   GET    /portal/invoices/:id/pdf     download invoice PDF
//   GET    /portal/invoices/:id/cfdi    download CFDI XML for invoice
//   POST   /portal/invoices/:id/pay     create a checkout session
//   GET    /portal/payments             payment history
//
//   --- §11.3 Self-Service Actions ---
//   GET    /portal/service-requests          list own requests
//   POST   /portal/service-requests          create a request
//   POST   /portal/service-requests/:id/cancel  cancel pending request
//
//   --- §11.4 Support ---
//   GET    /portal/tickets              list own tickets
//   POST   /portal/tickets             open a new ticket
//   GET    /portal/tickets/:id          ticket detail + comments
//   POST   /portal/tickets/:id/comments add a comment
//   GET    /portal/kb                   list knowledge-base articles
//   GET    /portal/kb/:slugOrId         get KB article detail
//   POST   /portal/kb/:slugOrId/rate    rate a KB article helpful/unhelpful
//   POST   /portal/speed-test           queue a speed test job
//   GET    /portal/speed-test/results   list speed test results
//   POST   /portal/chat/start           start an AI chat session
//   POST   /portal/chat/:token/message  send a chat message, get AI reply
//   GET    /portal/callback-request     submit a callback request (creates ticket)
//
//   --- §11.5 Mobile / PWA ---
//   POST   /portal/push/subscribe       register Web Push subscription
//   DELETE /portal/push/subscribe       remove Web Push subscription
//
//   --- §10.3 Data Packs (pre-existing) ---
//   GET    /portal/data-packs
//   POST   /portal/data-packs/:packId/purchase
//   GET    /portal/data-packs/my-purchases
//   GET    /portal/usage/allowance
// =============================================================================

const { Router } = require('express');
const { portalAuthenticate } = require('../middleware/portalAuth');
const { validate } = require('../middleware/validate');
// authLimiter guards the credential endpoint (/auth/login) only. Route-level
// apiLimiter was REMOVED everywhere else: app.js already applies apiLimiter to
// all of /api/, so a second router-level pass double-counted every portal
// request against the same per-IP bucket (and /auth/refresh + /auth/me now
// live in the dedicated sessionLimiter carve-out — see middleware/rateLimit.js).
// portalPasswordResetLimiter is a DEDICATED instance from the staff-side
// passwordResetLimiter (see its doc comment in middleware/rateLimit.js) —
// sharing one instance across the staff and portal routes would silently
// merge their budgets since express-rate-limit's default store keys by IP.
const { portalAuthLimiter: authLimiter, portalPasswordResetLimiter } = require('../middleware/rateLimit');
const portalAuthService = require('../services/portalAuthService');
const checkoutService = require('../services/checkoutService');
const db = require('../config/database');
const { NotFoundError, ValidationError } = require('../utils/errors');
const dataPackService = require('../services/dataPackService');
const portalServiceRequestService = require('../services/portalServiceRequestService');
const privacyNoticeService = require('../services/privacyNoticeService');
const pdfService = require('../services/pdfService');
const aiReplyService = require('../services/aiReplyService');
const { computeClientBalance } = require('../services/clientBalanceService');
const whatsappService = require('../services/whatsappService');
const config = require('../config');
const logger = require('../utils/logger');
const { buildUnverifiableSessionOverlap } = require('../utils/accountingUsageCompleteness');
const { creditAppliedSql } = require('../utils/invoiceBalance');
const radiusService = require('../services/radiusService');

const router = Router();

// ---------------------------------------------------------------------------
// Validation schemas (portal-specific)
// ---------------------------------------------------------------------------

const portalLoginSchema = {
  email: { type: 'email', required: true },
  password: { type: 'string', required: true, min: 1, max: 200 },
};

const portalRequestPasswordResetSchema = {
  email: { type: 'email', required: true },
};

const portalResetPasswordSchema = {
  token: { type: 'string', required: true },
  password: { type: 'string', required: true, min: 8, max: 200 },
};

const portalRefreshSchema = {
  refreshToken: { type: 'string', required: true },
};

const portalPasswordSchema = {
  currentPassword: { type: 'string', required: true, min: 1 },
  newPassword: { type: 'string', required: true, min: 8, max: 200 },
};

const createTicketSchema = {
  subject: { type: 'string', required: true, min: 1, max: 300 },
  description: { type: 'string', max: 5000 },
  priority: { type: 'string', enum: ['low', 'medium', 'high'] },
  // Mirrors the tickets.category ENUM (migration 394). Optional for
  // subscribers — omitted tickets land in 'general'.
  category: { type: 'string', enum: ['technical', 'billing', 'installation', 'general'] },
};

const createCommentSchema = {
  body: { type: 'string', required: true, min: 1, max: 5000 },
};

const createServiceRequestSchema = {
  request_type: {
    type: 'string',
    required: true,
    enum: ['plan_upgrade', 'wifi_password_change', 'pppoe_password_change',
      'static_ip_request', 'cancellation', 'visit_schedule'],
  },
  payload: { type: 'object' },
};

const chatMessageSchema = {
  message: { type: 'string', required: true, min: 1, max: 2000 },
};

const pushSubscribeSchema = {
  endpoint: { type: 'string', required: true, min: 10, max: 2048 },
  p256dh: { type: 'string', required: true },
  auth: { type: 'string', required: true },
  notify_outage: { type: 'boolean' },
  notify_billing: { type: 'boolean' },
  notify_ticket: { type: 'boolean' },
};

const kbRateSchema = {
  helpful: { type: 'boolean', required: true },
};

// ---------------------------------------------------------------------------
// AUTH — public endpoints
// ---------------------------------------------------------------------------

// POST /portal/auth/login
router.post('/auth/login', authLimiter, validate(portalLoginSchema), async (req, res, next) => {
  try {
    const result = await portalAuthService.login(req.body);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /portal/auth/refresh
// Uses the general NOT the strict authLimiter: the portal SPA keeps its
// access token in memory and re-exchanges the (localStorage) refresh token on every
// page load, so the strict 20/window limiter would 429 a frequently-reloaded session
// and bounce the customer to the login screen. /auth/login stays on authLimiter.
router.post('/auth/refresh', validate(portalRefreshSchema), async (req, res, next) => {
  try {
    const result = await portalAuthService.refreshToken(req.body.refreshToken);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /portal/auth/logout
router.post('/auth/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    await portalAuthService.logout(refreshToken);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

// POST /portal/auth/password-reset/request
router.post('/auth/password-reset/request', authLimiter, portalPasswordResetLimiter,
  validate(portalRequestPasswordResetSchema), async (req, res, next) => {
    try {
      const result = await portalAuthService.requestPasswordReset(req.body.email);

      // Respond BEFORE ever touching email — see auth.js's identical
      // timing-oracle note. Only a real hit carries a token; the
      // anti-enumeration branch inside requestPasswordReset() returns just
      // { message } with none, so the send below can never fire for it.
      res.json({ message: result.message || 'If that email exists, a reset link has been sent' });

      // One email per account at the address (WHK-10).
      for (const reset of result.resets || []) {
        try {
          const emailTransport = require('../services/emailTransport');
          const templates = require('../views/emailTemplates');
          const config = require('../config');
          const resetUrl = `${config.appUrl}/portal/reset-password?token=${reset.token}`;
          const template = templates.passwordResetEmail({
            userName: reset.userName,
            resetUrl,
            expiresIn: '1 hour',
          });
          emailTransport.sendEmail({
            organizationId: reset.organizationId,
            clientId: reset.clientId,
            messageClass: 'security',
            to: reset.email,
            subject: template.subject,
            html: template.html,
          })
            .then((sendResult) => {
              if (!sendResult || !sendResult.success) {
                logger.warn(`Portal password reset email failed to send to ${reset.email}: ${sendResult && sendResult.error}`);
              }
            })
            .catch((emailErr) => {
              logger.error(`Portal password reset email send threw: ${emailErr.message}`);
            });
        } catch (emailErr) {
          // Synchronous failure (e.g. require()/template build) — the
          // response is already sent above, so just log it.
          logger.error(`Portal password reset email send threw: ${emailErr.message}`);
        }
      }
    } catch (err) {
      next(err);
    }
  });

// POST /portal/auth/password-reset
router.post('/auth/password-reset', authLimiter, validate(portalResetPasswordSchema), async (req, res, next) => {
  try {
    const result = await portalAuthService.resetPassword(req.body.token, req.body.password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// All routes below require a valid portal JWT
// ---------------------------------------------------------------------------
router.use(portalAuthenticate);

// GET /portal/auth/me
router.get('/auth/me', (req, res) => {
  res.json({ data: req.client });
});

// PUT /portal/auth/password — update portal password
router.put('/auth/password', validate(portalPasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Verify current password before allowing change
    const [rows] = await db.query(
      'SELECT portal_password_hash FROM clients WHERE id = ? AND deleted_at IS NULL',
      [req.client.id],
    );
    if (!rows[0] || !rows[0].portal_password_hash) {
      throw new ValidationError('Portal password is not set for this account');
    }
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(currentPassword, rows[0].portal_password_hash);
    if (!valid) {
      throw new ValidationError('Current password is incorrect');
    }

    await portalAuthService.setPassword(req.client.id, newPassword);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// WHATSAPP LINKING (docs/whatsapp-support-design.md)
// The portal session IS the proof of account ownership; minting a code here and
// texting it to the bot binds the WhatsApp number to this client.
// ---------------------------------------------------------------------------

function maskPhone(e164) {
  const s = String(e164 || '');
  return s.length <= 4 ? s : `••••${s.slice(-4)}`;
}

// POST /portal/whatsapp/link-code — mint a short-lived linking code + wa.me link.
router.post('/whatsapp/link-code', async (req, res, next) => {
  try {
    // Cap pending codes per client so an authenticated client can't inflate the
    // verification table (and marginally raise cross-client collision odds).
    const pending = await whatsappService.pendingPortalCodeCount(req.client.id, req.client.organizationId);
    if (pending >= config.whatsapp.maxCodesPerHour) {
      throw new ValidationError('Too many linking codes requested. Please wait a few minutes and try again.');
    }
    const code = await whatsappService.createPortalLinkCode({
      organizationId: req.client.organizationId,
      clientId: req.client.id,
    });
    const num = (config.whatsapp.businessNumber || '').replace(/\D/g, '');
    res.json({
      data: {
        code,
        deepLink: num ? `https://wa.me/${num}?text=${encodeURIComponent(code)}` : null,
        businessNumber: config.whatsapp.businessNumber || null,
        expiresInMinutes: config.whatsapp.linkCodeTtlMinutes,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal/whatsapp/status — this client's active WhatsApp links (masked).
router.get('/whatsapp/status', async (req, res, next) => {
  try {
    const links = await whatsappService.listClientLinks(req.client.id, req.client.organizationId);
    res.json({
      data: {
        linked: links.length > 0,
        links: links.map((l) => ({
          id: l.id,
          phone: maskPhone(l.phone_e164),
          boundVia: l.bound_via,
          boundAt: l.bound_at,
          lastSeenAt: l.last_seen_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /portal/whatsapp/link/:id — unlink one of this client's numbers.
router.delete('/whatsapp/link/:id', async (req, res, next) => {
  try {
    const linkId = parseInt(req.params.id, 10);
    if (!Number.isInteger(linkId)) throw new ValidationError('Invalid link id');
    const ok = await whatsappService.revokeLink({
      clientId: req.client.id,
      organizationId: req.client.organizationId,
      linkId,
    });
    if (!ok) throw new NotFoundError('WhatsApp link not found');
    res.json({ message: 'WhatsApp number disconnected' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// AUTOPAY (Stripe off-session card capture)
// ---------------------------------------------------------------------------

// POST /portal/autopay/enroll — start Stripe setup-mode card capture; the client
// is redirected to the returned setup_url to save a card + accept the mandate.
router.post('/autopay/enroll', async (req, res, next) => {
  try {
    const autopayService = require('../services/autopayService');
    const result = await autopayService.startEnrollment({
      organizationId: req.client.organizationId,
      clientId: req.client.id,
      returnUrl: req.body.return_url || null,
    });
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// GET /portal/autopay/status — is autopay enabled for this client?
router.get('/autopay/status', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT id, card_brand, card_last_four, created_at FROM recurring_payment_profiles
        WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY is_default DESC, id DESC LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    res.json({ data: { enabled: rows.length > 0, profile: rows[0] || null } });
  } catch (err) {
    next(err);
  }
});

// DELETE /portal/autopay — disable autopay (revoke the active profile).
router.delete('/autopay', async (req, res, next) => {
  try {
    await db.query(
      `UPDATE recurring_payment_profiles SET status = 'revoked'
        WHERE client_id = ? AND organization_id <=> ? AND status = 'active'`,
      [req.client.id, req.client.organizationId],
    );
    // Turning autopay off also stops any retry still scheduled for the card.
    await db.query(
      `UPDATE payment_retries pr
         JOIN recurring_payment_profiles rp ON rp.id = pr.recurring_profile_id
          SET pr.status = 'cancelled', pr.completed_at = NOW(), pr.next_retry_at = NULL,
              pr.last_error = 'Autopay disabled by the subscriber'
        WHERE rp.client_id = ? AND rp.organization_id <=> ?
          AND pr.status IN ('pending', 'processing')`,
      [req.client.id, req.client.organizationId],
    );
    res.json({ message: 'Autopay disabled' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// INVOICES
// ---------------------------------------------------------------------------

// GET /portal/invoices — list own invoices (paginated)
// An issued or sent invoice past its due date shows (and filters) as overdue,
// the same derivation as the staff invoice list (FE-14).
const PORTAL_PAST_DUE_SQL = "(i.status IN ('issued', 'sent', 'overdue') AND i.due_date < CURDATE())";
const PORTAL_STATUS_SQL = `CASE WHEN ${PORTAL_PAST_DUE_SQL} THEN 'overdue' ELSE i.status END AS status`;

router.get('/invoices', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    // invoices has no discount_amount/period_start/period_end columns — there
    // is no discount concept anywhere on invoices (dropped; the frontend
    // already renders it conditionally), and the billing period dates live on
    // billing_periods, linked via invoice_id.
    // Bound to the subscriber's own organization as well as client_id: an
    // invoice another tenant issued against this client_id (TNB-05) must never
    // surface here. Null-safe <=> because invoices.organization_id (and the
    // client's) may be NULL on a single-tenant install.
    let whereClause = 'WHERE i.client_id = ? AND i.organization_id <=> ? AND i.deleted_at IS NULL';
    const params = [req.client.id, req.client.organizationId];

    // 'overdue' is derived, never stored (see routes/invoices.js): filtering
    // on the column returned nothing and past-due invoices read ISSUED (FE-14).
    if (status === 'overdue') {
      whereClause += ` AND ${PORTAL_PAST_DUE_SQL}`;
    } else if (status === 'issued' || status === 'sent') {
      whereClause += ` AND i.status = ? AND NOT ${PORTAL_PAST_DUE_SQL}`;
      params.push(status);
    } else if (status) {
      whereClause += ' AND i.status = ?';
      params.push(status);
    }

    // HIGH — item 5 of the second adversarial review: billing_periods has no
    // UNIQUE constraint on invoice_id alone (only on contract_id +
    // period_start), so a plain LEFT JOIN could return MORE THAN ONE row per
    // invoice — the customer would see the same invoice duplicated in the
    // list, and the separate COUNT (which never joined) would disagree with
    // how many rows actually rendered, breaking pagination. Dedup to at most
    // one billing_periods row per invoice (the most recent period) before
    // joining, so list and count are always consistent.
    const [rows] = await db.query(
      `SELECT i.id, i.invoice_number, i.subtotal, i.tax_amount, i.total,
              i.currency, bp.period_start, bp.period_end, i.due_date, i.paid_at, ${PORTAL_STATUS_SQL}, i.created_at
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_id, period_start, period_end,
                ROW_NUMBER() OVER (PARTITION BY invoice_id ORDER BY period_start DESC) AS rn
         FROM billing_periods
         WHERE invoice_id IS NOT NULL
       ) bp ON bp.invoice_id = i.id AND bp.rn = 1
       ${whereClause}
       ORDER BY i.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const [[{ total: count }]] = await db.query(
      `SELECT COUNT(*) AS total FROM invoices i ${whereClause}`,
      params,
    );

    res.json({
      data: rows,
      meta: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal/invoices/:id — invoice detail + items
router.get('/invoices/:id', async (req, res, next) => {
  try {
    // See the /invoices list route above for why discount_amount is dropped,
    // period_start/period_end come from a join to billing_periods, and that
    // join is deduped to one row per invoice (billing_periods.invoice_id has
    // no UNIQUE constraint of its own).
    const [rows] = await db.query(
      `SELECT i.id, i.invoice_number, i.subtotal, i.tax_amount, i.total,
              i.currency, bp.period_start, bp.period_end, i.due_date, i.paid_at, ${PORTAL_STATUS_SQL}, i.notes, i.created_at,
              (i.total - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa
                                    WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL), 0)
                       - ${creditAppliedSql('i')}) AS balance_due,
              EXISTS (SELECT 1 FROM payment_transactions pt
                       WHERE pt.invoice_id = i.id AND pt.organization_id <=> i.organization_id
                         AND pt.gateway_status = 'pending' AND pt.payment_id IS NULL) AS pending_checkout,
              EXISTS (SELECT 1 FROM cfdi_documents cd
                       WHERE cd.invoice_id = i.id AND cd.organization_id <=> i.organization_id
                         AND cd.sat_status = 'vigente') AS has_cfdi
       FROM invoices i
       LEFT JOIN (
         SELECT invoice_id, period_start, period_end,
                ROW_NUMBER() OVER (PARTITION BY invoice_id ORDER BY period_start DESC) AS rn
         FROM billing_periods
         WHERE invoice_id IS NOT NULL
       ) bp ON bp.invoice_id = i.id AND bp.rn = 1
       WHERE i.id = ? AND i.client_id = ? AND i.organization_id <=> ? AND i.deleted_at IS NULL`,
      [req.params.id, req.client.id, req.client.organizationId],
    );

    if (!rows[0]) throw new NotFoundError('Invoice');

    // invoice_items has tax_rate_id (an FK), not a tax_rate value — join
    // tax_rates for the actual rate.
    const [items] = await db.query(
      `SELECT ii.id, ii.description, ii.quantity, ii.unit_price, ii.amount, tr.rate AS tax_rate
       FROM invoice_items ii
       LEFT JOIN tax_rates tr ON tr.id = ii.tax_rate_id
       WHERE ii.invoice_id = ? AND ii.deleted_at IS NULL`,
      [req.params.id],
    );

    const [payments] = await db.query(
      `SELECT pa.amount AS allocated_amount, p.payment_method, p.payment_date
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       WHERE pa.invoice_id = ? AND pa.deleted_at IS NULL`,
      [req.params.id],
    );

    res.json({
      data: {
        ...rows[0],
        balance_due: Math.max(0, Math.round(Number(rows[0].balance_due || 0) * 100) / 100),
        pending_checkout: Boolean(Number(rows[0].pending_checkout)),
        has_cfdi: Boolean(Number(rows[0].has_cfdi)),
        items,
        payments,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/invoices/:id/pay — create a checkout session (online payment)
router.post('/invoices/:id/pay', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      // Org-bound (see GET /invoices) so a foreign-tenant invoice carrying this
      // client_id can never open a checkout on that tenant's gateway.
      'SELECT id, organization_id FROM invoices WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.params.id, req.client.id, req.client.organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Invoice');

    const session = await checkoutService.createCheckoutSession({
      organizationId: rows[0].organization_id,
      invoiceId: rows[0].id,
      clientId: req.client.id,
      returnUrl: req.body.return_url || null,
    });

    res.status(201).json({ data: session });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// TICKETS
// ---------------------------------------------------------------------------

// GET /portal/tickets — list own tickets (paginated)
router.get('/tickets', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    // Bound to the portal client's organization as well as client_id: a staff
    // ticket created in another org against this client_id (TNB-06) must not
    // surface here. <=> keeps an unattributed (NULL-org) client working.
    let whereClause = 'WHERE client_id = ? AND organization_id <=> ? AND deleted_at IS NULL';
    const params = [req.client.id, req.client.organizationId];

    if (status) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const [rows] = await db.query(
      `SELECT id, subject, priority, category, status, created_at, updated_at
       FROM tickets ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const [[{ total: count }]] = await db.query(
      `SELECT COUNT(*) AS total FROM tickets ${whereClause}`,
      params,
    );

    res.json({
      data: rows,
      meta: { page, limit, total: count, pages: Math.ceil(count / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/tickets — open a new ticket
router.post('/tickets', validate(createTicketSchema), async (req, res, next) => {
  try {
    const { subject, description, priority, category } = req.body;
    const [result] = await db.query(
      `INSERT INTO tickets
         (organization_id, client_id, subject, description, priority, category, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      [
        req.client.organizationId,
        req.client.id,
        subject,
        description || null,
        priority || 'medium',
        category || 'general',
      ],
    );

    const [rows] = await db.query(
      'SELECT id, subject, priority, category, status, created_at FROM tickets WHERE id = ? AND client_id = ? AND organization_id <=> ?',
      [result.insertId, req.client.id, req.client.organizationId],
    );
    await require('../services/businessEvents').emitTicketCreated(req.client.organizationId, result.insertId);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /portal/tickets/:id — ticket detail + comments
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT id, subject, description, priority, category, status, created_at, updated_at
       FROM tickets
       WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL`,
      [req.params.id, req.client.id, req.client.organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Ticket');

    const [comments] = await db.query(
      `SELECT tc.id, tc.body, tc.created_at
       FROM ticket_comments tc
       WHERE tc.ticket_id = ? AND tc.deleted_at IS NULL AND tc.is_internal = 0
       ORDER BY tc.created_at ASC`,
      [req.params.id],
    );

    res.json({ data: { ...rows[0], comments } });
  } catch (err) {
    next(err);
  }
});

// POST /portal/tickets/:id/comments — add a comment
router.post('/tickets/:id/comments', validate(createCommentSchema), async (req, res, next) => {
  try {
    const [ticketRows] = await db.query(
      'SELECT id, contract_id FROM tickets WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.params.id, req.client.id, req.client.organizationId],
    );
    if (!ticketRows[0]) throw new NotFoundError('Ticket');

    const [result] = await db.query(
      'INSERT INTO ticket_comments (ticket_id, body, is_internal) VALUES (?, ?, 0)',
      [req.params.id, req.body.body],
    );

    const [rows] = await db.query(
      'SELECT id, ticket_id, body, is_internal, created_at FROM ticket_comments WHERE id = ?',
      [result.insertId],
    );
    require('../services/pubsub').publishTicketComment(req.client.organizationId, ticketRows[0].id, rows[0]);

    // AI triage answers what the customer wrote (ASY-10: it used to run on
    // staff comments instead).
    require('../services/jobQueueService').add('ai-triage', {
      orgId:       req.client.organizationId,
      ticketId:    ticketRows[0].id,
      channel:     'portal',
      inboundText: req.body.body,
      contractId:  ticketRows[0].contract_id || null,
    }).catch(err => logger.warn({ err: err.message, ticketId: ticketRows[0].id }, 'aiTriage enqueue failed on portal comment'));

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DATA PACKS (§10.3 — portal self-service)
// ---------------------------------------------------------------------------

// GET /portal/data-packs — list available packs for this org
router.get('/data-packs', async (req, res, next) => {
  try {
    const packs = await dataPackService.listPacks(req.client.organizationId);
    res.json({ data: packs });
  } catch (err) {
    next(err);
  }
});

// POST /portal/data-packs/:packId/purchase — self-service purchase
router.post('/data-packs/:packId/purchase', async (req, res, next) => {
  try {
    // Resolve the subscriber's active contract
    const [contracts] = await db.query(
      `SELECT id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) throw new NotFoundError('Active contract');

    const purchase = await dataPackService.purchasePack(
      req.client.organizationId,
      contracts[0].id,
      req.params.packId,
      { purchasedBy: 'client_portal' },
    );
    res.status(201).json({ data: purchase });
  } catch (err) {
    next(err);
  }
});

// GET /portal/data-packs/my-purchases — list this client's purchases
router.get('/data-packs/my-purchases', async (req, res, next) => {
  try {
    const [contracts] = await db.query(
      `SELECT id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) return res.json({ data: [] });

    const purchases = await dataPackService.listPurchases(
      req.client.organizationId,
      contracts[0].id,
    );
    res.json({ data: purchases });
  } catch (err) {
    next(err);
  }
});

// GET /portal/usage/allowance — effective total data allowance
router.get('/usage/allowance', async (req, res, next) => {
  try {
    const [contracts] = await db.query(
      `SELECT id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) return res.json({ data: null });

    const allowance = await dataPackService.getEffectiveAllowance(contracts[0].id, req.client.organizationId);
    res.json({ data: allowance });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// §11.1 DASHBOARD
// ---------------------------------------------------------------------------

// GET /portal/dashboard — account overview (plan, balance, session, speed tier)
// Legal info for the portal footer: the client's compliance locale and where
// the Carta de Derechos Minimos lives (org override or the official IFT
// document). Read-only, tiny, safe to poll.
router.get('/legal-info', async (req, res, next) => {
  try {
    // req.client (portalAuthenticate) deliberately carries only the identity
    // columns — locale is NOT among them, so read it here alongside the org's
    // configured Carta URL in one round trip.
    const [rows] = await db.query(
      `SELECT c.locale, omp.carta_derechos_url
       FROM clients c
       LEFT JOIN organization_mx_profiles omp
         ON omp.organization_id = c.organization_id AND omp.deleted_at IS NULL
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      [req.client.id],
    );
    res.json({
      data: {
        locale: rows[0]?.locale || 'global',
        carta_derechos_url: rows[0]?.carta_derechos_url
          || 'https://www.ift.org.mx/usuarios-y-audiencias/carta-de-derechos-minimos-de-los-usuarios',
      },
    });
  } catch (err) { next(err); }
});

router.get('/dashboard', async (req, res, next) => {
  try {
    const clientId = req.client.id;

    // Contract + plan info
    const [contracts] = await db.query(
      `SELECT c.id AS contract_id, c.status AS contract_status, c.start_date,
              c.connection_type, c.ip_address,
              p.id AS plan_id, p.name AS plan_name, p.price,
              p.download_speed_mbps, p.upload_speed_mbps,
              p.billing_cycle, p.data_cap_gb
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id
       WHERE c.client_id = ? AND c.organization_id <=> ? AND c.status = 'active' AND c.deleted_at IS NULL
       LIMIT 1`,
      [clientId, req.client.organizationId],
    );
    const contract = contracts[0] || null;

    // Outstanding balance — COMPUTED from payable invoices minus unallocated
    // payment credit (see clientBalanceService's module doc). This used to be
    // a plain SUM(total) of unpaid invoices, which overstated what the client
    // owed whenever an invoice had a partial payment allocated to it, and
    // never credited an unapplied overpayment.
    const { balance, currency, balances, mixedCurrency } = await computeClientBalance(req.client.organizationId, clientId);

    // Next due date
    const [[{ next_due }]] = await db.query(
      `SELECT MIN(due_date) AS next_due
       FROM invoices
       WHERE client_id = ? AND organization_id <=> ? AND status IN ('issued','overdue') AND deleted_at IS NULL`,
      [clientId, req.client.organizationId],
    );

    // Current RADIUS session status. This joined `radacct`, a FreeRADIUS SQL
    // table VigaBSS never creates, with non-stock column names, so the
    // dashboard 500ed for every subscriber with an active contract (DB-03).
    // Live sessions come from VigaBSS's own connection_logs projection.
    let session = null;
    if (contract) {
      const [accounts] = await db.query(
        `SELECT r.username, r.status AS radius_status
         FROM radius r
         WHERE r.contract_id = ? AND r.organization_id <=> ? AND r.deleted_at IS NULL
         LIMIT 1`,
        [contract.contract_id, req.client.organizationId],
      );
      if (accounts[0]) {
        const live = await radiusService.getSessionByContractId(contract.contract_id, req.client.organizationId);
        session = {
          status: live ? 'connected' : 'disconnected',
          username: accounts[0].username,
          ip: live?.ip || null,
          mac: live?.calling_station_id || null,
          session_seconds: Number(live?.session_duration) || 0,
          bytes_in: Number(live?.bytes_in) || 0,
          bytes_out: Number(live?.bytes_out) || 0,
        };
      }
    }

    // Current month usage summary
    let usage = null;
    if (contract) {
      const now = new Date();
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const [[usageRow]] = await db.query(
        `SELECT COALESCE(SUM(bytes_in_delta), 0) AS bytes_in,
                COALESCE(SUM(bytes_out_delta), 0) AS bytes_out,
                COALESCE(SUM(is_complete = 0), 0) AS incomplete_rows,
                COUNT(*) AS observed_rows,
                (SELECT COUNT(*) FROM connection_logs unverifiable
                  WHERE unverifiable.organization_id = ? AND unverifiable.contract_id = ?
                    AND ${buildUnverifiableSessionOverlap(
    'unverifiable',
    "DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')",
    'UTC_TIMESTAMP(3)',
  )}) AS unverifiable_session_rows
           FROM radius_accounting_usage_daily
          WHERE organization_id = ? AND contract_id = ? AND usage_date >= ?`,
        [req.client.organizationId, contract.contract_id,
          req.client.organizationId, contract.contract_id, monthStart],
      );
      // SUM() over BIGINT is DECIMAL, which mysql2 returns as a string:
      // `bytes_in + bytes_out` concatenated them and total_gb came out as
      // tens of billions (FE-09).
      const bytesIn = Number(usageRow.bytes_in || 0);
      const bytesOut = Number(usageRow.bytes_out || 0);
      usage = {
        download_bytes: bytesIn,
        upload_bytes: bytesOut,
        total_bytes: bytesIn + bytesOut,
        download_gb: parseFloat((bytesIn / 1073741824).toFixed(3)),
        upload_gb: parseFloat((bytesOut / 1073741824).toFixed(3)),
        total_gb: parseFloat(((bytesIn + bytesOut) / 1073741824).toFixed(3)),
        usage_complete: Number(usageRow.observed_rows || 0) > 0
          && Number(usageRow.incomplete_rows || 0) === 0
          && Number(usageRow.unverifiable_session_rows || 0) === 0,
        unverifiable_session_rows: Number(usageRow.unverifiable_session_rows || 0),
      };
    }

    res.json({
      data: {
        client: {
          id: req.client.id,
          name: req.client.name,
          email: req.client.email,
        },
        contract: contract ? {
          id: contract.contract_id,
          status: contract.contract_status,
          connection_type: contract.connection_type,
          ip_address: contract.ip_address,
          plan: {
            id: contract.plan_id,
            name: contract.plan_name,
            price: parseFloat(contract.price),
            download_speed_mbps: contract.download_speed_mbps,
            upload_speed_mbps: contract.upload_speed_mbps,
            billing_cycle_months: contract.billing_cycle_months,
            data_cap_gb: contract.data_cap_gb,
          },
        } : null,
        // null when the account holds several currencies; balances lists
        // each one (GQL-10).
        balance,
        balance_currency: currency,
        balances,
        mixed_currency: mixedCurrency,
        next_due_date: next_due || null,
        session,
        usage_this_month: usage,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal/usage/current-month — daily usage breakdown for chart
router.get('/usage/current-month', async (req, res, next) => {
  try {
    const [contracts] = await db.query(
      `SELECT id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) return res.json({ data: [] });

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [rows] = await db.query(
      `SELECT u.usage_date AS date,
              COALESCE(SUM(u.bytes_in_delta), 0) AS download_bytes,
              COALESCE(SUM(u.bytes_out_delta), 0) AS upload_bytes,
              COALESCE(SUM(u.bytes_in_delta + u.bytes_out_delta), 0) AS total_bytes,
              COALESCE(SUM(u.is_complete = 0), 0) AS incomplete_rows,
              (SELECT COUNT(*) FROM connection_logs unverifiable
                WHERE unverifiable.organization_id = ? AND unverifiable.contract_id = ?
                  AND ${buildUnverifiableSessionOverlap(
    'unverifiable', 'u.usage_date', 'DATE_ADD(u.usage_date, INTERVAL 1 DAY)',
  )}) AS unverifiable_session_rows
       FROM radius_accounting_usage_daily u
       WHERE u.organization_id = ? AND u.contract_id = ? AND u.usage_date >= ?
       GROUP BY u.usage_date
       ORDER BY date ASC`,
      [req.client.organizationId, contracts[0].id,
        req.client.organizationId, contracts[0].id, monthStart],
    );

    res.json({
      data: rows.map(r => ({
        // A calendar day ('YYYY-MM-DD'): the DATE arrives as a UTC-midnight
        // Date, and the portal chart sliced its ISO string into labels like
        // '01T00:00:00.000Z' (FE-10).
        date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
        download_gb: parseFloat((r.download_bytes / 1073741824).toFixed(3)),
        upload_gb: parseFloat((r.upload_bytes / 1073741824).toFixed(3)),
        total_gb: parseFloat((r.total_bytes / 1073741824).toFixed(3)),
        usage_complete: Number(r.incomplete_rows || 0) === 0
          && Number(r.unverifiable_session_rows || 0) === 0,
        unverifiable_session_rows: Number(r.unverifiable_session_rows || 0),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// §11.2 BILLING — additional endpoints
// ---------------------------------------------------------------------------

// GET /portal/invoices/:id/pdf — download invoice as PDF
router.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, invoice_number, organization_id FROM invoices WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.params.id, req.client.id, req.client.organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Invoice');

    const pdfBuffer = await pdfService.generateInvoicePdf(rows[0].id, { locale: 'es', orgId: rows[0].organization_id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${rows[0].invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// GET /portal/invoices/:id/cfdi — download CFDI XML for an invoice
router.get('/invoices/:id/cfdi', async (req, res, next) => {
  try {
    const [invoiceRows] = await db.query(
      'SELECT id, client_id FROM invoices WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.params.id, req.client.id, req.client.organizationId],
    );
    if (!invoiceRows[0]) throw new NotFoundError('Invoice');

    const [cfdiRows] = await db.query(
      // cfdi_documents has no deleted_at (not soft-deleted) and the status
      // column is sat_status ENUM('draft','vigente','cancelado',
      // 'cancel_pending') — 'stamped' was never a legal value; 'vigente' is
      // "successfully stamped and valid".
      `SELECT cd.id, cd.uuid, cd.xml_content, cd.signed_xml, cd.sat_status
       FROM cfdi_documents cd
       WHERE cd.invoice_id = ? AND cd.organization_id <=> ?
         AND cd.sat_status = 'vigente'
       ORDER BY cd.created_at DESC
       LIMIT 1`,
      // Bound to the invoice's org too: a CFDI of another tenant that names
      // this invoice_id (BIL-10) must never be served as this client's XML.
      [req.params.id, req.client.organizationId],
    );
    // The stamped (signed_xml, with the TimbreFiscalDigital) document is the
    // fiscally valid one — xml_content is the pre-stamp builder draft, useless
    // for the client's accounting. Same rule as cfdiController.downloadXml.
    const fiscalXml = cfdiRows[0] && (cfdiRows[0].signed_xml || cfdiRows[0].xml_content);
    if (!fiscalXml) {
      throw new NotFoundError('CFDI document');
    }

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="cfdi-${cfdiRows[0].uuid || cfdiRows[0].id}.xml"`);
    res.send(fiscalXml);
  } catch (err) {
    next(err);
  }
});

// GET /portal/payments — payment history
router.get('/payments', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    // Bound to the subscriber's organization as well as client_id (list and
    // count alike): a payment another tenant recorded against this client_id
    // must never surface here. Null-safe <=> for single-tenant NULL-org rows.
    const [rows] = await db.query(
      `SELECT p.id, p.amount, p.currency, p.payment_method, p.payment_date,
              p.reference_number, p.status, p.notes, p.created_at
       FROM payments p
       WHERE p.client_id = ? AND p.organization_id <=> ? AND p.deleted_at IS NULL
       ORDER BY p.payment_date DESC, p.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [req.client.id, req.client.organizationId],
    );

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM payments WHERE client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.client.id, req.client.organizationId],
    );

    res.json({
      data: rows,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// §11.3 SELF-SERVICE REQUESTS
// ---------------------------------------------------------------------------

// GET /portal/service-requests — list own requests
// GET /portal/service-requests/plan-options — plans this subscriber may
// request a change to (the plan picker on the account page).
router.get('/service-requests/plan-options', async (req, res, next) => {
  try {
    const plans = await portalServiceRequestService.listUpgradePlans(req.client.id, req.client.organizationId);
    res.json({ data: plans });
  } catch (err) {
    next(err);
  }
});

router.get('/service-requests', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const requestType = req.query.request_type || null;

    const { rows, total } = await portalServiceRequestService.listRequests(
      req.client.id,
      req.client.organizationId,
      { page, limit, requestType },
    );
    res.json({
      data: rows,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/service-requests — create a new request
router.post('/service-requests', validate(createServiceRequestSchema), async (req, res, next) => {
  try {
    const { request_type, payload } = req.body;
    const request = await portalServiceRequestService.createRequest({
      clientId: req.client.id,
      organizationId: req.client.organizationId,
      requestType: request_type,
      payload: payload || {},
    });
    res.status(201).json({ data: request });
  } catch (err) {
    next(err);
  }
});

// POST /portal/service-requests/:id/cancel — cancel a pending request
router.post('/service-requests/:id/cancel', async (req, res, next) => {
  try {
    const result = await portalServiceRequestService.cancelRequest(
      req.params.id,
      req.client.id,
      req.client.organizationId,
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// §11.4 SUPPORT — knowledge base, speed test, AI chatbot, callback
// ---------------------------------------------------------------------------

// GET /portal/kb — list KB articles (public within portal)
router.get('/kb', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const { category, search } = req.query;

    const { rows, total } = await portalServiceRequestService.listKbArticles(
      req.client.organizationId,
      { category, search, page, limit },
    );
    res.json({
      data: rows,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal/kb/:slugOrId — get KB article detail
router.get('/kb/:slugOrId', async (req, res, next) => {
  try {
    const article = await portalServiceRequestService.getKbArticle(
      req.client.organizationId,
      req.params.slugOrId,
    );
    res.json({ data: article });
  } catch (err) {
    next(err);
  }
});

// POST /portal/kb/:slugOrId/rate — rate a KB article
router.post('/kb/:slugOrId/rate', validate(kbRateSchema), async (req, res, next) => {
  try {
    const result = await portalServiceRequestService.rateKbArticle(
      req.client.organizationId,
      req.params.slugOrId,
      req.body.helpful,
    );
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// POST /portal/speed-test — queue a speed test job for this client
router.post('/speed-test', async (req, res, next) => {
  try {
    const [contracts] = await db.query(
      `SELECT id, organization_id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) throw new ValidationError('No active contract found');

    // Pick an available test server for this org (or any global one)
    const [servers] = await db.query(
      `SELECT id FROM bandwidth_test_servers
       WHERE (organization_id = ? OR organization_id IS NULL)
         AND is_active = 1 AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.organizationId],
    );

    const [result] = await db.query(
      `INSERT INTO subscriber_speed_test_jobs
         (organization_id, contract_id, test_server_id, requested_by, scheduled_at, status)
       VALUES (?, ?, ?, 'client_portal', NOW(), 'queued')`,
      [
        contracts[0].organization_id,
        contracts[0].id,
        servers[0] ? servers[0].id : null,
      ],
    );

    res.status(201).json({
      data: {
        job_id: result.insertId,
        status: 'queued',
        message: 'Speed test has been queued. Results will be available shortly.',
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal/speed-test/results — list speed test results for this client
router.get('/speed-test/results', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const offset = (page - 1) * limit;

    const [contracts] = await db.query(
      `SELECT id FROM contracts
       WHERE client_id = ? AND organization_id <=> ? AND status = 'active' AND deleted_at IS NULL
       LIMIT 1`,
      [req.client.id, req.client.organizationId],
    );
    if (!contracts[0]) return res.json({ data: [], meta: { page, limit, total: 0, pages: 0 } });

    const [rows] = await db.query(
      `SELECT id, status, scheduled_at, completed_at, requested_by,
              download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct,
              protocol, error_message, created_at
       FROM subscriber_speed_test_jobs
       WHERE contract_id = ? AND organization_id <=> ?
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [contracts[0].id, req.client.organizationId],
    );

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM subscriber_speed_test_jobs WHERE contract_id = ? AND organization_id <=> ?',
      [contracts[0].id, req.client.organizationId],
    );

    res.json({
      data: rows,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/chat/start — start a new AI chat session
router.post('/chat/start', async (req, res, next) => {
  try {
    const token = portalServiceRequestService.generateChatToken();
    const [result] = await db.query(
      `INSERT INTO portal_chat_sessions
         (organization_id, client_id, session_token, messages, status, turn_count)
       VALUES (?, ?, ?, ?, 'active', 0)`,
      [req.client.organizationId, req.client.id, token, JSON.stringify([])],
    );
    res.status(201).json({
      data: {
        session_id: result.insertId,
        session_token: token,
        status: 'active',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/chat/:token/message — send a chat message, get AI reply
router.post('/chat/:token/message', validate(chatMessageSchema), async (req, res, next) => {
  try {
    const { token } = req.params;
    const { message } = req.body;

    // Verify session belongs to this client, in this client's organization.
    const [sessions] = await db.query(
      `SELECT id, messages, status, turn_count, ticket_id
       FROM portal_chat_sessions
       WHERE session_token = ? AND client_id = ? AND organization_id <=> ?`,
      [token, req.client.id, req.client.organizationId],
    );
    const session = sessions[0];
    if (!session) throw new NotFoundError('Chat session');
    if (session.status !== 'active') {
      throw new ValidationError(`Chat session is ${session.status}`);
    }

    const messages = Array.isArray(session.messages)
      ? session.messages
      : (typeof session.messages === 'string' ? JSON.parse(session.messages) : []);

    // Append client message
    messages.push({ role: 'client', content: message, ts: new Date().toISOString() });

    // One ticket per session (ASY-09): it used to INSERT a new open ticket
    // holding the whole transcript on every message, so with AI off (the
    // default) each message left another open ticket. The first message opens
    // it; later ones are added to it as the customer's comments.
    let ticketId = session.ticket_id || null;
    if (ticketId) {
      const [[live]] = await db.query(
        'SELECT id FROM tickets WHERE id = ? AND client_id = ? AND organization_id <=> ? AND deleted_at IS NULL',
        [ticketId, req.client.id, req.client.organizationId],
      );
      if (!live) ticketId = null;
    }
    if (ticketId) {
      const [comment] = await db.query('INSERT INTO ticket_comments (ticket_id, body, is_internal) VALUES (?, ?, 0)', [ticketId, message]);
      require('../services/pubsub').publishTicketComment(req.client.organizationId, ticketId, { id: comment.insertId, ticket_id: ticketId });
    } else {
      const [ticketResult] = await db.query(
        `INSERT INTO tickets
           (organization_id, client_id, subject, description, priority, category, status, source)
         VALUES (?, ?, ?, ?, 'medium', 'general', 'open', 'portal')`,
        [req.client.organizationId, req.client.id, `Chat session ${token.slice(0, 8)}`, message],
      );
      ticketId = ticketResult.insertId;
      await require('../services/businessEvents').emitTicketCreated(req.client.organizationId, ticketId);
    }

    // The subscriber sees AI text only when the policy auto-sends it and the
    // reply was actually posted ('auto_sent'). A draft (draft_only, the
    // default, or suggest) is kept for staff review, and a failed or skipped
    // generation hands the chat to staff: the ticket stays open and the
    // session is escalated, so the promise of a follow-up is kept.
    const HOLDING_REPLY = 'Thanks — a member of our support team will reply on your ticket shortly.';
    let aiText = HOLDING_REPLY;
    let handedToStaff = true;
    try {
      const aiResult = await aiReplyService.generate({
        orgId: req.client.organizationId,
        ticketId,
        channel: 'portal',
        inboundText: message,
      });
      if (!aiResult.skipped && aiResult.action === 'auto_sent' && aiResult.draftText) {
        aiText = aiResult.draftText;
        handedToStaff = false;
        // Answered; the ticket waits for the customer instead of a 48 h
        // escalation.
        await db.query(
          "UPDATE tickets SET status = 'waiting' WHERE id = ? AND client_id = ? AND organization_id <=> ? AND status = 'open'",
          [ticketId, req.client.id, req.client.organizationId],
        );
      }
    } catch (aiErr) {
      logger.warn({ err: aiErr.message, ticketId }, 'Portal chat AI reply failed; handing the chat to staff');
    }

    messages.push({ role: 'ai', content: aiText, ts: new Date().toISOString() });

    const newTurnCount = (session.turn_count || 0) + 1;
    const newStatus = handedToStaff ? 'escalated' : 'active';

    await db.query(
      `UPDATE portal_chat_sessions
       SET messages = ?, turn_count = ?, status = ?, ticket_id = ?, updated_at = NOW()
       WHERE id = ? AND client_id = ? AND organization_id <=> ?`,
      [JSON.stringify(messages), newTurnCount, newStatus, ticketId,
        session.id, req.client.id, req.client.organizationId],
    );

    res.json({
      data: {
        reply: aiText,
        session_status: newStatus,
        turn_count: newTurnCount,
        ticket_id: ticketId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/callback-request — create a callback request ticket
router.post('/callback-request', async (req, res, next) => {
  try {
    const { preferred_time, phone, notes } = req.body || {};
    const description = [
      'Callback request from client portal.',
      phone ? `Phone: ${phone}` : null,
      preferred_time ? `Preferred time: ${preferred_time}` : null,
      notes ? `Notes: ${notes}` : null,
    ].filter(Boolean).join('\n');

    const [result] = await db.query(
      `INSERT INTO tickets
         (organization_id, client_id, subject, description, priority, category, status)
       VALUES (?, ?, 'Callback Request', ?, 'medium', 'general', 'open')`,
      [req.client.organizationId, req.client.id, description],
    );

    const [rows] = await db.query(
      'SELECT id, subject, priority, status, created_at FROM tickets WHERE id = ? AND client_id = ? AND organization_id <=> ?',
      [result.insertId, req.client.id, req.client.organizationId],
    );
    await require('../services/businessEvents').emitTicketCreated(req.client.organizationId, result.insertId);

    res.status(201).json({ data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// §11.5 WEB PUSH SUBSCRIPTIONS
// ---------------------------------------------------------------------------

// POST /portal/push/subscribe — register / update Web Push subscription
router.post('/push/subscribe', validate(pushSubscribeSchema), async (req, res, next) => {
  try {
    const { endpoint, p256dh, auth, notify_outage, notify_billing, notify_ticket } = req.body;
    const result = await portalServiceRequestService.upsertPushSubscription({
      clientId: req.client.id,
      organizationId: req.client.organizationId,
      endpoint,
      p256dh,
      auth,
      userAgent: req.headers['user-agent'] || null,
      notifyOutage: notify_outage !== undefined ? notify_outage : null,
      notifyBilling: notify_billing !== undefined ? notify_billing : null,
      notifyTicket: notify_ticket !== undefined ? notify_ticket : null,
    });
    res.status(result.updated ? 200 : 201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Privacy notice (LFPDPPP) — display + acceptance
// ---------------------------------------------------------------------------
// The consent tables and staff routes have existed since migration 314, but
// nothing ever DISPLAYED the notice to a subscriber or wrote a consent row
// through the product. These two endpoints close that: the portal renders the
// org's notice and records acceptance with the version and content hash of
// the exact text that was shown.

// The active-consent lookup binds the client's organization as well as
// client_id: a client_id match alone is not a tenant boundary (another org's
// row naming this client_id must never read as this subscriber's consent).
// Null-safe <=> keeps single-tenant rows, whose organization_id is NULL by
// design, matching. Every writer (this route, the staff consent route, the
// installation handoff) stores the client's own organization.
//
// document_hash is compared, not just stored. Version alone is not enough: the
// version is free text an operator is never forced to change, so editing the
// notice — adding a finalidad, say — while leaving the version box alone would
// otherwise keep every prior acceptance reading as current against text that no
// longer exists. That is exactly the claim this feature is meant to be able to
// prove. The IS NULL arm keeps hash-less rows counting: staff-recorded paper
// and phone consents (and any row predating this feature) are an operator's
// attestation, not a hash of served text, so they must not be invalidated.
const CONSENT_LOOKUP_SQL =
  `SELECT id, given_at FROM subscriber_consents
   WHERE client_id = ? AND organization_id <=> ? AND purpose = 'service_delivery'
     AND consent_version = ? AND (document_hash IS NULL OR document_hash = ?)
     AND withdrawn_at IS NULL
   ORDER BY given_at DESC LIMIT 1`;

// GET /portal/privacy-notice — the notice text + whether THIS version is accepted
router.get('/privacy-notice', async (req, res, next) => {
  try {
    const notice = await privacyNoticeService.getNotice(req.client.organizationId);
    const [rows] = await db.query(CONSENT_LOOKUP_SQL, [req.client.id, req.client.organizationId, notice.version, notice.hash]);
    res.json({
      data: {
        version: notice.version,
        content: notice.content,
        accepted: rows.length > 0,
        accepted_at: rows[0]?.given_at ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /portal/privacy-notice/accept — record acceptance (idempotent per version)
router.post('/privacy-notice/accept', async (req, res, next) => {
  try {
    const notice = await privacyNoticeService.getNotice(req.client.organizationId);
    const [existing] = await db.query(CONSENT_LOOKUP_SQL, [req.client.id, req.client.organizationId, notice.version, notice.hash]);
    if (existing.length > 0) {
      return res.json({ data: { accepted: true, accepted_at: existing[0].given_at } });
    }
    await db.query(
      `INSERT INTO subscriber_consents
         (organization_id, client_id, consent_version, purpose, channel, ip_address, document_hash, given_at)
       VALUES (?, ?, ?, 'service_delivery', 'web', ?, ?, NOW())`,
      [req.client.organizationId, req.client.id, notice.version, req.ip || null, notice.hash],
    );
    const [rows] = await db.query(CONSENT_LOOKUP_SQL, [req.client.id, req.client.organizationId, notice.version, notice.hash]);
    res.status(201).json({ data: { accepted: true, accepted_at: rows[0]?.given_at ?? null } });
  } catch (err) {
    next(err);
  }
});

// DELETE /portal/push/subscribe — remove a Web Push subscription
router.delete('/push/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) throw new ValidationError('endpoint is required');
    await portalServiceRequestService.deletePushSubscription(req.client.id, req.client.organizationId, endpoint);
    res.json({ message: 'Push subscription removed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
