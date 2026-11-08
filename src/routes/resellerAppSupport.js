// =============================================================================
// VigaBSS 5.0 — Reseller app (Punto de Venta), phase 5b: support
// =============================================================================
// Mounted by routes/resellerApp.js after authenticate, orgScope,
// resellerScope and requireBoundReseller, so every route here is for a user
// bound to a reseller; clients and leads are those of its subtree (404
// otherwise).
//
//  POST /reseller-app/tickets                    "Reportar falla" for a client
//  GET  /reseller-app/tickets                    the faults its subtree reported
//  GET  /reseller-app/leads/:id/signing          the signing state of a lead's installation
//  POST /reseller-app/leads/:id/signing-link     ask the ISP to send the customer its signing link
//
// A reported fault is a normal ticket of the ISP's queue (source 'reseller',
// tickets.reseller_id = the reporting user's reseller); staff are notified as
// for any new ticket, the customer is not. The signing link is the ISP's
// (services/documentSigningLinkService.js): it goes to the customer's email or
// phone on file and the reseller never sees it.
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { AppError, NotFoundError } = require('../utils/errors');
const { inPlaceholders } = require('../utils/sqlBuild');
const auditLog = require('../services/auditLog');
const businessEvents = require('../services/businessEvents');
const links = require('../services/documentSigningLinkService');

const router = Router();

// The most faults one reseller may report in 24 hours.
const DAILY_TICKETS = 30;

const positiveId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const subtree = (req) => req.resellerScope.resellerIds;

function pagination(query, defaultLimit = 20) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), 50);
  return { page, limit, offset: (page - 1) * limit };
}

async function clientInScope(req, clientId) {
  const id = positiveId(clientId);
  const ids = subtree(req);
  if (!id || !ids.length) throw new NotFoundError('Client');
  const [[client]] = await db.query(
    `SELECT c.id, c.name FROM clients c
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL
        AND c.reseller_id IN (${inPlaceholders(ids)})
      LIMIT 1`,
    [id, req.orgId, ...ids],
  );
  if (!client) throw new NotFoundError('Client');
  return client;
}

// =============================================================================
// Reportar falla
// =============================================================================
const ticketSchema = {
  client_id:   { type: 'number', required: true, min: 1 },
  subject:     { type: 'string', required: true, min: 3, max: 150 },
  description: { type: 'string', required: true, min: 5, max: 2000 },
  category:    { type: 'string', enum: ['technical', 'billing', 'installation', 'general'] },
};

function ticketRow(t) {
  return {
    id: Number(t.id),
    client_id: Number(t.client_id),
    client_name: t.client_name ?? null,
    subject: t.subject,
    category: t.category,
    status: t.status,
    created_at: t.created_at,
    updated_at: t.updated_at ?? null,
    resolved_at: t.resolved_at ?? null,
  };
}

// POST /reseller-app/tickets
router.post('/tickets', requirePermission('reseller_app.tickets'), validate(ticketSchema), async (req, res, next) => {
  try {
    const client = await clientInScope(req, req.body.client_id);
    const resellerId = Number(req.resellerScope.rootId);
    const [[recent]] = await db.query(
      `/* includes deleted rows: a deleted report still counts toward the daily budget */
       SELECT COUNT(*) AS n FROM tickets
        WHERE organization_id = ? AND source = 'reseller' AND reseller_id = ?
          AND created_at >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)`,
      [req.orgId, resellerId],
    );
    if ((Number(recent?.n) || 0) >= DAILY_TICKETS) {
      const err = new AppError(`At most ${DAILY_TICKETS} faults can be reported in 24 hours`, 429, 'TOO_MANY_TICKETS');
      throw err;
    }
    const [[reseller]] = await db.query(
      'SELECT name FROM resellers WHERE id = ? AND organization_id = ?',
      [resellerId, req.orgId],
    );
    const subject = String(req.body.subject).trim();
    const description = String(req.body.description).trim();
    const notes = `Reportado desde el punto de venta ${reseller?.name ?? `#${resellerId}`} por ${req.user.email ?? `el usuario #${req.user.id}`}.`;
    const [result] = await db.query(
      `INSERT INTO tickets
         (organization_id, client_id, subject, description, notes, priority, category, status, source, reseller_id)
       VALUES (?, ?, ?, ?, ?, 'medium', ?, 'open', 'reseller', ?)`,
      [req.orgId, client.id, subject, description, notes, req.body.category || 'technical', resellerId],
    );
    const [[row]] = await db.query(
      'SELECT * FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [result.insertId, req.orgId],
    );
    await businessEvents.emitTicketCreated(req.orgId, row);
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'reseller_ticket_create',
      tableName: 'tickets',
      recordId: Number(result.insertId),
      newValues: { client_id: Number(client.id), reseller_id: resellerId, subject },
    });
    res.status(201).json({ data: ticketRow({ ...row, client_name: client.name }) });
  } catch (err) { next(err); }
});

// GET /reseller-app/tickets?client_id=
router.get('/tickets', requirePermission('reseller_app.tickets'), async (req, res, next) => {
  try {
    const ids = subtree(req);
    const { page, limit, offset } = pagination(req.query);
    if (!ids.length) return res.json({ data: [], meta: { total: 0, page, limit } });
    const where = [
      't.organization_id = ?', "t.source = 'reseller'", 't.deleted_at IS NULL',
      `t.reseller_id IN (${inPlaceholders(ids)})`, `c.reseller_id IN (${inPlaceholders(ids)})`,
    ];
    const params = [req.orgId, ...ids, ...ids];
    if (req.query.client_id !== undefined && req.query.client_id !== '') {
      const clientId = positiveId(req.query.client_id);
      if (!clientId) throw new NotFoundError('Client');
      where.push('t.client_id = ?');
      params.push(clientId);
    }
    const from = `FROM tickets t
       JOIN clients c ON c.id = t.client_id AND c.organization_id = t.organization_id AND c.deleted_at IS NULL
      WHERE ${where.join(' AND ')}`;
    const [rows] = await db.query(
      `SELECT t.id, t.client_id, c.name AS client_name, t.subject, t.category, t.status, t.created_at, t.updated_at, t.resolved_at
         ${from}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const [[count]] = await db.query(`SELECT COUNT(*) AS total ${from}`, params);
    res.json({ data: (rows || []).map(ticketRow), meta: { total: Number(count?.total) || 0, page, limit } });
  } catch (err) { next(err); }
});

// =============================================================================
// The signing link of a lead's installation
// =============================================================================

/** The lead of the subtree and its latest new installation order. */
async function leadOrder(req) {
  const id = positiveId(req.params.id);
  const ids = subtree(req);
  if (!id || !ids.length) throw new NotFoundError('Lead');
  const [[lead]] = await db.query(
    `SELECT id FROM leads
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
        AND reseller_id IN (${inPlaceholders(ids)})
      LIMIT 1`,
    [id, req.orgId, ...ids],
  );
  if (!lead) throw new NotFoundError('Lead');
  const [[order]] = await db.query(
    `SELECT so.id, so.status, so.client_id, c.email AS client_email, c.phone AS client_phone
       FROM service_orders so
       LEFT JOIN clients c ON c.id = so.client_id AND c.organization_id = so.organization_id AND c.deleted_at IS NULL
      WHERE so.organization_id = ? AND so.lead_id = ? AND so.order_type = 'new_install' AND so.deleted_at IS NULL
      ORDER BY so.id DESC
      LIMIT 1`,
    [req.orgId, lead.id],
  );
  return { lead, order: order || null };
}

// GET /reseller-app/leads/:id/signing
router.get('/leads/:id/signing', requirePermission('reseller_app.signup'), async (req, res, next) => {
  try {
    const { order } = await leadOrder(req);
    if (!order) {
      return res.json({ data: { state: 'no_installation', pending_documents: 0, signed_documents: 0, can_send: false, contacts: null, last_link: null } });
    }
    const [[counts]] = await db.query(
      `SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'signed'), 0) AS signed
         FROM signed_documents
        WHERE organization_id = ? AND service_order_id = ? AND client_id <=> ? AND deleted_at IS NULL`,
      [req.orgId, order.id, order.client_id],
    );
    const pending = Number(counts?.pending) || 0;
    const signed = Number(counts?.signed) || 0;
    const [last] = await links.listForOrder(req.orgId, order.id);
    const state = order.status !== 'in_process' ? (order.status === 'done' ? 'installed' : 'not_started')
      : pending > 0 ? 'pending' : 'signed';
    res.json({
      data: {
        state,
        pending_documents: pending,
        signed_documents: signed,
        can_send: state === 'pending' && Boolean(order.client_email || order.client_phone),
        contacts: { email: Boolean(order.client_email), phone: Boolean(order.client_phone) },
        last_link: last ? {
          channel: last.channel,
          destination_masked: last.destination_masked,
          created_at: last.created_at,
          expires_at: last.expires_at,
          completed_at: last.completed_at,
          revoked_at: last.revoked_at,
          opened: Boolean(last.last_opened_at),
        } : null,
      },
    });
  } catch (err) { next(err); }
});

// POST /reseller-app/leads/:id/signing-link
router.post(
  '/leads/:id/signing-link',
  requirePermission('reseller_app.signup'),
  validate({ channel: { type: 'string', required: true, enum: ['email', 'sms'] } }),
  async (req, res, next) => {
    try {
      const { lead, order } = await leadOrder(req);
      if (!order) {
        throw new AppError('The ISP has not started this customer\'s installation yet', 409, 'ORDER_NOT_SIGNABLE');
      }
      const resellerId = Number(req.resellerScope.rootId);
      const result = await links.create({
        orgId: req.orgId, serviceOrderId: order.id, channel: req.body.channel, requestedBy: req.user.id, resellerId,
      });
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId,
        action: 'signing_link_create',
        tableName: 'document_signing_links',
        recordId: result.link.id,
        newValues: { lead_id: Number(lead.id), service_order_id: Number(order.id), channel: result.link.channel, reseller_id: resellerId },
      });
      // Never the link itself: the ISP sends it to the customer.
      res.status(201).json({ data: { link: result.link, message: result.message } });
    } catch (err) { next(err); }
  },
);

module.exports = router;
