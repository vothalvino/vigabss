// =============================================================================
// VigaBSS 5.0 — SMS Routes
// =============================================================================
// Provides admin access to SMS delivery logs, manual send, and retry.
// =============================================================================

const { Router } = require('express');
const db = require('../config/database');
const smsTransport = require('../services/smsTransport');
const messageOutbox = require('../services/messageOutbox');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');

const router = Router();

router.use(authenticate, orgScope);

// ---------------------------------------------------------------------------
// GET /sms/logs — paginated SMS delivery log
// ---------------------------------------------------------------------------
router.get('/logs', requirePermission('sms.view'), async (req, res) => {
  const {
    page     = 1,
    pageSize = 20,
    status,
    channel,
    clientId,
    phone,
  } = req.query;

  const limit  = Math.min(parseInt(pageSize, 10) || 20, 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  let where  = 'WHERE sl.organization_id = ?';
  const params = [req.orgId];

  if (status)   { where += ' AND sl.status = ?';       params.push(status); }
  if (channel)  { where += ' AND sl.channel = ?';      params.push(channel); }
  if (clientId) { where += ' AND sl.client_id = ?';    params.push(clientId); }
  if (phone)    { where += ' AND sl.phone_number LIKE ?'; params.push(`%${phone}%`); }

  const countSql = `SELECT COUNT(*) AS total FROM sms_logs sl ${where}`;
  const dataSql  = `
    SELECT sl.*,
           c.name AS client_name
      FROM sms_logs sl
      LEFT JOIN clients c ON c.id = sl.client_id
     ${where}
     ORDER BY sl.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`;

  const [[{ total }]] = await db.query(countSql, params);
  const [rows]        = await db.query(dataSql, params);

  res.json({
    data:  rows,
    total: Number(total),
    page:  Number(page),
    pageSize: limit,
  });
});

// ---------------------------------------------------------------------------
// POST /sms/send — send an SMS immediately (admin/support tool)
// ---------------------------------------------------------------------------
const sendSchema = {
  to:      { type: 'string', required: true, min: 7, max: 20 },
  body:    { type: 'string', required: true, min: 1, max: 1600 },
  channel: { type: 'string', enum: ['sms', 'whatsapp'] },
  clientId: { type: 'number', required: true, min: 1 },
  templateId: { type: 'number' },
};

router.post('/send', requirePermission('sms.send'), validate(sendSchema, { strip: false }), async (req, res, next) => {
  try {
    const { to, body, channel = 'sms', clientId, templateId = null } = req.body;
    smsTransport.assertClientSmsAttribution({ organizationId: req.orgId, clientId, messageClass: 'support_reply' });
    // Through the outbox, delivered now (ASY-33): same consent checks and
    // log as every other message, and a provably unsent failure is retried.
    const result = await messageOutbox.sendNow({
      channel, organizationId: req.orgId, clientId, messageClass: 'support_reply',
      recipient: to, bodyText: body, payload: templateId ? { template_id: templateId } : null,
      sourceType: 'staff_sms',
    });
    res.status(SEND_STATUS[result.status] || 502).json({
      success: result.status === 'sent',
      outbox_id: result.id,
      status: result.status,
      ...(result.providerMessageId && { messageId: result.providerMessageId }),
      ...(result.status !== 'sent' && result.error && { error: result.error }),
      ...(result.code && { code: result.code }),
    });
  } catch (err) { next(err); }
});

// sent: delivered; queued: the provider was unreachable, the outbox retries
// it; skipped: consent or the organization blocks it.
const SEND_STATUS = { sent: 200, queued: 202, skipped: 409 };

// ---------------------------------------------------------------------------
// POST /sms/logs/:id/retry — send a failed SMS again, through the outbox
// ---------------------------------------------------------------------------
router.post('/logs/:id/retry', requirePermission('sms.send'), async (req, res, next) => {
  try {
    const logId = parseInt(req.params.id, 10);
    const [rows] = await db.query(
      `SELECT id, client_id, phone_number, channel, template_id, message_body, message_class, status
         FROM sms_logs WHERE id = ? AND organization_id = ? AND direction = 'outbound'`,
      [logId, req.orgId],
    );
    const log = rows[0];
    if (!log) return res.status(404).json({ error: 'SMS log not found' });
    if (!['failed', 'undelivered'].includes(log.status) || !log.client_id || !log.message_class) {
      return res.status(409).json({ success: false, code: 'SMS_NOT_RETRYABLE', error: `A ${log.status} message without a client and class cannot be retried.` });
    }
    // One retry per log row: a second click returns the same outbox message.
    const result = await messageOutbox.sendNow({
      channel: log.channel, organizationId: req.orgId, clientId: log.client_id, messageClass: log.message_class,
      recipient: log.phone_number, bodyText: log.message_body,
      payload: log.template_id ? { template_id: log.template_id } : null,
      sourceType: 'sms_log_retry', sourceId: log.id, dedupeKey: `sms_log_retry:${req.orgId}:${log.id}`,
    });
    res.status(SEND_STATUS[result.status] || 502).json({
      success: result.status === 'sent',
      outbox_id: result.id,
      status: result.status,
      ...(result.providerMessageId && { messageId: result.providerMessageId }),
      ...(result.status !== 'sent' && result.error && { error: result.error }),
      ...(result.code && { code: result.code }),
    });
  } catch (err) { next(err); }
});

module.exports = router;
