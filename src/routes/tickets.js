// =============================================================================
// VigaBSS 5.0 — Ticket Routes
// =============================================================================

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Router } = require('express');
const Ticket = require('../models/Ticket');
const Client = require('../models/Client');
const Contract = require('../models/Contract');
const User = require('../models/User');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission, userHasPermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createTicket, updateTicket, patchTicket, createComment, updateComment } = require('../middleware/schemas/tickets');
const db = require('../config/database');
const { NotFoundError, ValidationError } = require('../utils/errors');
const { pubsub } = require('../services/pubsub');
const jobQueue = require('../services/jobQueueService');
const logger = require('../utils/logger').child({ service: 'routes/tickets' });
const aiReplyService = require('../services/aiReplyService');
const { attachmentStorage, resolveStoredPath, STORAGE_ROOT,
  attachmentFileFilter, attachmentMimeType, contentDispositionAttachment } = require('../middleware/upload');

// ---------------------------------------------------------------------------
// Multer — ticket attachments (disk storage, 20 MB limit)
// ---------------------------------------------------------------------------
// Under STORAGE_ROOT, which is the ONLY directory any deployment mounts:
// `storage:/app/storage` in docker-compose.prod.yml and the fireisp-storage PVC
// in k8s/deployment.yaml. The previous ../../uploads/tickets was mounted by
// nothing, so attachments lived in the container's writable layer and were
// destroyed by every redeploy.
const ticketAttachUpload = multer({
  storage: attachmentStorage('tickets'),
  // Was absent: this path accepted ANY extension and ANY mime type, with
  // the 20 MB cap as the only restriction (j35).
  fileFilter: attachmentFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
}).single('file');

function uploadAttachment(req, res, next) {
  ticketAttachUpload(req, res, (err) => {
    if (err) return res.status(422).json({ error: err.message });
    next();
  });
}

const router = Router();

// Ticket statuses in which a ticket is still being worked (i.e. NOT resolved or
// closed). Reopening from a terminal state into one of these clears resolved_at.
const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting'];

// resolved_at is server-managed and drives downstream CSAT dispatch, so it is
// stamped/cleared here on the actual status transition rather than trusted from
// the request body:
//   * entering 'resolved'                       -> stamp resolved_at = now
//   * reopening a resolved/closed ticket into an -> clear resolved_at = NULL
//     active state (open / in_progress / waiting)
// Any other transition (e.g. resolved -> closed) leaves resolved_at untouched.
const ctrl = crudController(Ticket, {
  beforeUpdate: async (old, req) => {
    // Never accept a client-supplied resolved_at — the hook is the sole authority.
    delete req.body.resolved_at;

    // PUT/PATCH may re-point the ticket at another client/contract/assignee:
    // each must belong to the caller's organization (TNB-06).
    await assertTicketFks(req.body, req.orgId);

    const nextStatus = req.body.status;
    if (nextStatus === undefined || nextStatus === old.status) return;

    if (nextStatus === 'resolved') {
      req.body.resolved_at = new Date();
    } else if (
      (old.status === 'resolved' || old.status === 'closed')
      && ACTIVE_STATUSES.includes(nextStatus)
    ) {
      req.body.resolved_at = null;
    }
  },
});

router.use(authenticate);
router.use(orgScope);

// ---------------------------------------------------------------------------
// Ticket ownership + billing-category visibility (migration 394)
// ---------------------------------------------------------------------------
// requireOwnedTicket is the chokepoint for /:id and every subresource
// (comments, time logs, attachments, relations, AI triage, merge). After the
// route's normal permission check passes, it loads the ticket by
// :id/:ticketId bound to the caller's organization and 404s when it is not
// there. ticket_comments / ticket_relations / ticket_time_logs carry no
// organization_id of their own, so the parent ticket is their ONLY tenant
// boundary. The previous guard only looked for a billing ticket in req.orgId
// and fell through on a miss, so another organization's ticket id reached
// every subresource handler unchecked (TNB-06).
//
// It then keeps the billing-category rule: roles without tickets.view_billing
// (e.g. technician) get the same 404 for a billing ticket, indistinguishable
// from a nonexistent or foreign one. Running AFTER requirePermission keeps
// 403-before-404 ordering, so unauthorized callers can't use the status code
// as a category or existence oracle.
function ownedTicketGuard({ includeDeleted = false } = {}) {
  return async function ownedTicketMw(req, _res, next) {
    try {
      const ticketId = req.params.id ?? req.params.ticketId;
      if (!/^\d+$/.test(String(ticketId))) throw new NotFoundError('Ticket');
      const [[ticket]] = await db.query(
        `SELECT id, category FROM tickets WHERE id = ? AND organization_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
        [ticketId, req.orgId],
      );
      if (!ticket) throw new NotFoundError('Ticket');
      if (ticket.category === 'billing' && !(await userHasPermission(req, 'tickets.view_billing'))) {
        throw new NotFoundError('Ticket');
      }
      next();
    } catch (err) { next(err); }
  };
}

/** requirePermission + the org-ownership/billing guard, for every ticket :id route. */
function requireOwnedTicket(...perms) {
  return [requirePermission(...perms), ownedTicketGuard()];
}

// Restore targets a soft-deleted ticket, so its ownership lookup must not
// filter deleted_at (the organization predicate still applies).
function requireOwnedTicketIncludingDeleted(...perms) {
  return [requirePermission(...perms), ownedTicketGuard({ includeDeleted: true })];
}

// client_id / contract_id / assigned_to reference other org-scoped tables.
// validate() only checks type/min, so without this a foreign id was stored
// verbatim: POST /tickets {client_id: <org B client>} put an org-A ticket in
// front of org B's subscriber in their portal. Only checks the fields present.
// Mirrors serviceOrders.js#assertServiceOrderFks.
async function assertTicketFks(body, orgId) {
  if (body.client_id !== undefined && body.client_id !== null) {
    const client = await Client.findById(body.client_id, orgId);
    if (!client) throw new ValidationError('client_id does not belong to this organization');
  }
  if (body.contract_id !== undefined && body.contract_id !== null) {
    const contract = await Contract.findById(body.contract_id, orgId);
    if (!contract) throw new ValidationError('contract_id does not belong to this organization');
  }
  if (body.assigned_to !== undefined && body.assigned_to !== null) {
    // User.count with an orgId applies the Users page's organization-visibility
    // rule (home org, explicit membership, or an installation-wide identity).
    const visible = await User.count({ where: { id: body.assigned_to }, orgId });
    if (!Number(visible)) throw new ValidationError('assigned_to is not a user of this organization');
  }
}

router.get('/', requirePermission('tickets.view'), async (req, res, next) => {
  try {
    if (await userHasPermission(req, 'tickets.view_billing')) {
      return ctrl.list(req, res, next);
    }
    // Scoped list: same contract as crudController.list (filters on fillable
    // columns, pagination meta) but excluding billing-category tickets.
    const { page = 1, limit = 50, order_by, order, ...filters } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * safeLimit;
    const conditions = ['organization_id = ?', 'deleted_at IS NULL', "category <> 'billing'"];
    const params = [req.orgId];
    for (const [col, val] of Object.entries(filters)) {
      if (Ticket.fillable.includes(col) || col === 'id') {
        conditions.push(`\`${col}\` = ?`);
        params.push(val);
      }
    }
    const safeOrderBy = Ticket.sortable.includes(order_by) ? order_by : 'id';
    const dir = order === 'DESC' ? 'DESC' : 'ASC';
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const [[rows], [[{ total }]]] = await Promise.all([
      db.query(
        `SELECT * FROM tickets ${whereClause} ORDER BY \`${safeOrderBy}\` ${dir} LIMIT ${safeLimit} OFFSET ${offset}`,
        params,
      ),
      db.query(`SELECT COUNT(*) AS total FROM tickets ${whereClause}`, params),
    ]);
    res.json({
      data: rows,
      meta: {
        total,
        page: Math.max(1, parseInt(page, 10) || 1),
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) { next(err); }
});

// GET /tickets/stats — ticket counts by status (must be before /:id)
router.get('/stats', requirePermission('tickets.view'), async (req, res, next) => {
  try {
    const canSeeBilling = await userHasPermission(req, 'tickets.view_billing');
    const [rows] = await db.query(
      `SELECT status, COUNT(*) AS count
       FROM tickets
       WHERE organization_id = ? AND deleted_at IS NULL
         ${canSeeBilling ? '' : "AND category <> 'billing'"}
       GROUP BY status`,
      [req.orgId],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// POST /tickets/from-alert — create a ticket from an alert event
router.post('/from-alert', requirePermission('tickets.create'), async (req, res, next) => {
  try {
    const { alert_event_id, client_id, subject, description, priority } = req.body;
    if (!alert_event_id || !client_id || !subject) {
      return res.status(422).json({ error: 'alert_event_id, client_id, and subject are required' });
    }
    await assertTicketFks({ client_id }, req.orgId);
    const [result] = await db.query(
      `INSERT INTO tickets
         (organization_id, client_id, subject, description, priority, category, status, source)
       VALUES (?, ?, ?, ?, ?, 'technical', 'open', 'alert')`,
      [req.orgId, client_id, subject, description || null, priority || 'medium'],
    );
    const [[row]] = await db.query(
      'SELECT * FROM tickets WHERE id = ? AND organization_id = ?',
      [result.insertId, req.orgId],
    );
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

router.get('/:id', requireOwnedTicket('tickets.view'), ctrl.get);
router.post('/', requirePermission('tickets.create'), validate(createTicket), async (req, res, next) => {
  try {
    await assertTicketFks(req.body, req.orgId);
    if (Ticket.hasOrgScope && req.orgId) {
      req.body.organization_id = req.orgId;
    }
    const record = await Ticket.create(req.body);

    // Enqueue AI triage for the initial description (fires async, non-blocking)
    if (record.description) {
      jobQueue.add('ai-triage', {
        orgId:       req.orgId,
        ticketId:    record.id,
        channel:     req.body.channel || 'portal',
        inboundText: record.description,
        contractId:  record.contract_id || null,
      }).catch(err => logger.warn({ err: err.message, ticketId: record.id }, 'aiTriage enqueue failed on ticket create — AI reply will not be generated'));
    }

    res.status(201).json({ data: record });
  } catch (err) { next(err); }
});
router.put('/:id', requireOwnedTicket('tickets.update'), validate(updateTicket), ctrl.update);
router.patch('/:id', requireOwnedTicket('tickets.update'), validate(patchTicket), ctrl.partialUpdate);
router.delete('/:id', requireOwnedTicket('tickets.delete'), ctrl.destroy);
router.post('/:id/restore', requireOwnedTicketIncludingDeleted('tickets.update'), ctrl.restore);

// Ticket comments
router.get('/:id/comments', requireOwnedTicket('tickets.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT tc.*, u.first_name, u.last_name FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id WHERE tc.ticket_id = ? AND tc.deleted_at IS NULL ORDER BY tc.created_at ASC',
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// Posting a comment needs tickets.comment (granted to technician, migration
// 483) or tickets.update; editing and deleting comments are unchanged (DB-23).
router.post('/:id/comments', requireOwnedTicket('tickets.update', 'tickets.comment'), validate(createComment), async (req, res, next) => {
  try {
    const { body, is_internal } = req.body;
    const [result] = await db.query(
      'INSERT INTO ticket_comments (ticket_id, user_id, body, is_internal) VALUES (?, ?, ?, ?)',
      [req.params.id, req.user.id, body, is_internal || false],
    );
    const [rows] = await db.query('SELECT * FROM ticket_comments WHERE id = ?', [result.insertId]);
    pubsub.publish('TICKET_COMMENT_ADDED', { ticketCommentAdded: rows[0], ticketId: String(req.params.id) });

    // Enqueue AI triage when a client posts a new non-internal comment
    if (!is_internal) {
      const [[ticket]] = await db.query(
        'SELECT id, organization_id, contract_id FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
        [req.params.id, req.orgId],
      );
      if (ticket) {
        jobQueue.add('ai-triage', {
          orgId:       ticket.organization_id,
          ticketId:    ticket.id,
          channel:     'portal',
          inboundText: body,
          contractId:  ticket.contract_id || null,
        }).catch(err => logger.warn({ err: err.message, ticketId: ticket.id }, 'aiTriage enqueue failed on comment'));
      }
    }

    res.status(201).json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id/comments/:commentId', requireOwnedTicket('tickets.update'), validate(updateComment), async (req, res, next) => {
  try {
    const { body, is_internal } = req.body;
    const [result] = await db.query(
      'UPDATE ticket_comments SET body = ?, is_internal = ? WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL',
      [body, is_internal ?? false, req.params.commentId, req.params.id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    const [rows] = await db.query('SELECT * FROM ticket_comments WHERE id = ?', [req.params.commentId]);
    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:id/comments/:commentId', requireOwnedTicket('tickets.delete'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE ticket_comments SET deleted_at = NOW() WHERE id = ? AND ticket_id = ? AND deleted_at IS NULL',
      [req.params.commentId, req.params.id],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket relations
// ---------------------------------------------------------------------------
router.get('/:id/relations', requireOwnedTicket('ticket_relations.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT tr.*, ta.subject AS ticket_a_subject, tb.subject AS ticket_b_subject,
              ta.category AS ticket_a_category, tb.category AS ticket_b_category
       FROM ticket_relations tr
       JOIN tickets ta ON ta.id = tr.ticket_id_a AND ta.organization_id = ?
       JOIN tickets tb ON tb.id = tr.ticket_id_b AND tb.organization_id = ?
       WHERE tr.ticket_id_a = ? OR tr.ticket_id_b = ?`,
      // Both sides bound to the caller's org: a relation row created before
      // the related_ticket_id check (TNB-06) must not surface a foreign
      // ticket's subject.
      [req.orgId, req.orgId, req.params.id, req.params.id],
    );
    // The requested ticket is already non-billing for restricted users (guard),
    // but the JOIN pulls the RELATED ticket's subject — drop relations that
    // touch a billing ticket so those subjects never leak.
    const canSeeBilling = await userHasPermission(req, 'tickets.view_billing');
    const visible = canSeeBilling
      ? rows
      : rows.filter(r => r.ticket_a_category !== 'billing' && r.ticket_b_category !== 'billing');
    res.json({
      data: visible.map(({ ticket_a_category: _a, ticket_b_category: _b, ...rest }) => rest),
    });
  } catch (err) { next(err); }
});

router.post('/:id/relations', requireOwnedTicket('ticket_relations.manage'), async (req, res, next) => {
  try {
    const { related_ticket_id, relation_type } = req.body;
    if (!related_ticket_id) return res.status(422).json({ error: 'related_ticket_id is required' });
    // The guard covers :id only — the related ticket must be in this org too.
    const [[related]] = await db.query(
      'SELECT id FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [related_ticket_id, req.orgId],
    );
    if (!related) throw new ValidationError('related_ticket_id does not belong to this organization');
    const [result] = await db.query(
      'INSERT INTO ticket_relations (ticket_id_a, ticket_id_b, relation_type, created_by) VALUES (?, ?, ?, ?)',
      [req.params.id, related_ticket_id, relation_type || 'related', req.user.id],
    );
    const [[row]] = await db.query('SELECT * FROM ticket_relations WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

router.delete('/:id/relations/:relId', requireOwnedTicket('ticket_relations.manage'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM ticket_relations WHERE id = ? AND (ticket_id_a = ? OR ticket_id_b = ?)',
      [req.params.relId, req.params.id, req.params.id],
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Relation not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket time logs
// ---------------------------------------------------------------------------
router.get('/:id/time-logs', requireOwnedTicket('ticket_time_logs.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT tl.*, u.first_name, u.last_name
       FROM ticket_time_logs tl
       LEFT JOIN users u ON u.id = tl.user_id
       WHERE tl.ticket_id = ?
       ORDER BY tl.work_date DESC, tl.created_at DESC`,
      [req.params.id],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/time-logs', requireOwnedTicket('ticket_time_logs.manage'), async (req, res, next) => {
  try {
    const { minutes, work_date, description } = req.body;
    if (!minutes || !work_date) {
      return res.status(422).json({ error: 'minutes and work_date are required' });
    }
    const [result] = await db.query(
      'INSERT INTO ticket_time_logs (ticket_id, user_id, minutes, work_date, description) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, req.user.id, minutes, work_date, description || null],
    );
    const [[row]] = await db.query('SELECT * FROM ticket_time_logs WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

router.put('/:id/time-logs/:logId', requireOwnedTicket('ticket_time_logs.manage'), async (req, res, next) => {
  try {
    const { minutes, work_date, description } = req.body;
    if (!minutes || !work_date) {
      return res.status(422).json({ error: 'minutes and work_date are required' });
    }
    const [result] = await db.query(
      'UPDATE ticket_time_logs SET minutes = ?, work_date = ?, description = ? WHERE id = ? AND ticket_id = ?',
      [minutes, work_date, description || null, req.params.logId, req.params.id],
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Time log not found' });
    const [[row]] = await db.query('SELECT * FROM ticket_time_logs WHERE id = ?', [req.params.logId]);
    res.json({ data: row });
  } catch (err) { next(err); }
});

router.delete('/:id/time-logs/:logId', requireOwnedTicket('ticket_time_logs.manage'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'DELETE FROM ticket_time_logs WHERE id = ? AND ticket_id = ?',
      [req.params.logId, req.params.id],
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Time log not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket AI triage
// ---------------------------------------------------------------------------
router.get('/:id/ai-triage', requireOwnedTicket('tickets.view'), async (req, res, next) => {
  try {
    // ticket_ai_triage has no organization_id column — scope through the ticket
    // so one tenant can never read another tenant's triage (suggested_resolution
    // carries the PII-rehydrated reply text).
    const [[row]] = await db.query(
      `SELECT tat.* FROM ticket_ai_triage tat
       JOIN tickets t ON t.id = tat.ticket_id
       WHERE tat.ticket_id = ? AND t.organization_id = ? AND t.deleted_at IS NULL`,
      [req.params.id, req.orgId],
    );
    if (!row) return res.status(404).json({ error: 'No triage result found for this ticket' });
    res.json({ data: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket AI summary
// ---------------------------------------------------------------------------
router.post('/:id/ai-summary', requireOwnedTicket('tickets.view'), async (req, res, next) => {
  try {
    const [[ticket]] = await db.query(
      'SELECT id, subject, description, organization_id, contract_id FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const result = await aiReplyService.generate({
      orgId:      ticket.organization_id,
      ticketId:   ticket.id,
      channel:    'portal',
      inboundText: ticket.description || ticket.subject,
      contractId: ticket.contract_id || null,
    });
    res.json({ data: result });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket attachments
// ---------------------------------------------------------------------------
router.get('/:id/attachments', requireOwnedTicket('ticket_attachments.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, filename, original_filename, mime_type, file_size, uploaded_by, created_at FROM ticket_attachments WHERE ticket_id = ? AND organization_id = ? ORDER BY created_at DESC',
      [req.params.id, req.orgId],
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.post('/:id/attachments', requireOwnedTicket('ticket_attachments.create'), uploadAttachment, async (req, res, next) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'No file uploaded' });
    const [result] = await db.query(
      'INSERT INTO ticket_attachments (ticket_id, filename, original_filename, mime_type, file_size, storage_path, uploaded_by, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      // Relative to STORAGE_ROOT, matching clients.js and files.js. An absolute
      // path would break the moment the install root differs from the one that
      // wrote it — /app under Docker, /opt/fireisp from install.sh, or a backup
      // restored onto another host.
      [req.params.id, req.file.filename, req.file.originalname, attachmentMimeType(req.file.originalname), req.file.size,
        path.relative(STORAGE_ROOT, req.file.path), req.user.id, req.orgId],
    );
    const [[row]] = await db.query('SELECT id, filename, original_filename, mime_type, file_size, uploaded_by, created_at FROM ticket_attachments WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) { next(err); }
});

router.delete('/:ticketId/attachments/:attachmentId', requireOwnedTicket('ticket_attachments.delete'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      'SELECT storage_path FROM ticket_attachments WHERE id = ? AND ticket_id = ? AND organization_id = ?',
      [req.params.attachmentId, req.params.ticketId, req.orgId],
    );
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    await db.query('DELETE FROM ticket_attachments WHERE id = ?', [req.params.attachmentId]);
    const abs = resolveStoredPath(row.storage_path);
    if (abs) fs.unlink(abs, () => {});
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/:ticketId/attachments/:attachmentId/download', requireOwnedTicket('ticket_attachments.view'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      'SELECT * FROM ticket_attachments WHERE id = ? AND ticket_id = ? AND organization_id = ?',
      [req.params.attachmentId, req.params.ticketId, req.orgId],
    );
    if (!row) return res.status(404).json({ error: 'Attachment not found' });
    const abs = resolveStoredPath(row.storage_path);
    if (!abs) return res.status(404).json({ error: 'Attachment file not found' });
    res.setHeader('Content-Disposition', contentDispositionAttachment(row.original_filename));
    res.setHeader('Content-Type', row.mime_type);
    res.sendFile(abs);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Ticket merge
// ---------------------------------------------------------------------------
router.post('/:id/merge', requireOwnedTicket('tickets.update'), async (req, res, next) => {
  try {
    const { source_ticket_id } = req.body;
    if (!source_ticket_id) return res.status(422).json({ error: 'source_ticket_id is required' });
    // The guard only covers the :id param — validate the body-supplied source
    // ticket the same way: it must exist in this org, and users without
    // tickets.view_billing can't merge (and thereby read) a billing ticket.
    const [[source]] = await db.query(
      'SELECT category FROM tickets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [source_ticket_id, req.orgId],
    );
    if (!source) return res.status(404).json({ error: 'Source ticket not found' });
    if (source.category === 'billing' && !(await userHasPermission(req, 'tickets.view_billing'))) {
      return res.status(404).json({ error: 'Source ticket not found' });
    }
    // Move comments from source to target, then close source
    await db.query(
      'UPDATE ticket_comments SET ticket_id = ? WHERE ticket_id = ?',
      [req.params.id, source_ticket_id],
    );
    await db.query(
      `UPDATE tickets SET status = 'closed', deleted_at = NOW()
       WHERE id = ? AND organization_id = ?`,
      [source_ticket_id, req.orgId],
    );
    const [[row]] = await db.query(
      'SELECT * FROM tickets WHERE id = ? AND organization_id = ?',
      [req.params.id, req.orgId],
    );
    res.json({ data: { target: row, merged_from_id: Number(source_ticket_id) } });
  } catch (err) { next(err); }
});

module.exports = router;
