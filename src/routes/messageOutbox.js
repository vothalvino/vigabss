// =============================================================================
// VigaBSS 5.0 — Message outbox routes (ASY-33)
// =============================================================================
// Staff see what is waiting, what failed and what may not have arrived, and
// retry or cancel it. Bodies and attachments are only on GET /:id.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const messageOutbox = require('../services/messageOutbox');
const auditLog = require('../services/auditLog');

const router = Router();
router.use(authenticate, orgScope);

const STATUSES = ['queued', 'claimed', 'sending', 'sent', 'skipped', 'failed', 'outcome_unknown', 'cancelled'];
const retrySchema = { confirm_possible_duplicate: { type: 'boolean' } };

router.get('/', requirePermission('message_outbox.view'), async (req, res, next) => {
  try {
    const { status, channel, client_id: clientId, page, limit } = req.query;
    if (status && !STATUSES.includes(status)) {
      return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${STATUSES.join(', ')}` } });
    }
    if (channel && !messageOutbox.CHANNELS.includes(channel)) {
      return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `channel must be one of: ${messageOutbox.CHANNELS.join(', ')}` } });
    }
    res.json(await messageOutbox.list(req.orgId, { status, channel, clientId, page, limit }));
  } catch (err) { next(err); }
});

router.get('/summary', requirePermission('message_outbox.view'), async (req, res, next) => {
  try {
    res.json({ data: await messageOutbox.summary(req.orgId) });
  } catch (err) { next(err); }
});

router.get('/:id', requirePermission('message_outbox.view'), async (req, res, next) => {
  try {
    res.json({ data: await messageOutbox.get(Number(req.params.id), req.orgId) });
  } catch (err) { next(err); }
});

router.post('/:id/retry', requirePermission('message_outbox.manage'), validate(retrySchema), async (req, res, next) => {
  try {
    const data = await messageOutbox.retry(Number(req.params.id), req.orgId, {
      confirmPossibleDuplicate: req.body?.confirm_possible_duplicate === true,
    });
    await auditLog.log({
      userId: req.user?.id, organizationId: req.orgId, action: 'update',
      tableName: 'message_outbox', recordId: data.id, summary: 'Retried an outgoing message',
    });
    res.json({ data });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requirePermission('message_outbox.manage'), async (req, res, next) => {
  try {
    const data = await messageOutbox.cancel(Number(req.params.id), req.orgId);
    await auditLog.log({
      userId: req.user?.id, organizationId: req.orgId, action: 'update',
      tableName: 'message_outbox', recordId: data.id, summary: 'Cancelled an outgoing message',
    });
    res.json({ data });
  } catch (err) { next(err); }
});

module.exports = router;
