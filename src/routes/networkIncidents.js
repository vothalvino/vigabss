// =============================================================================
// VigaBSS 5.0 — network incidents (technicians)
// =============================================================================
// Faulty lines and equipment of the network tree, opened by the watch or by a
// customer's report. A technician closes one with a comment; the customers who
// reported it are then told, by a message that is sent or waits for approval.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const incidents = require('../services/networkIncidentService');
const notices = require('../services/incidentNoticeService');

const router = Router();
router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('topology.view'), async (req, res, next) => {
  try { res.json({ data: await incidents.list(req.orgId, { status: req.query.status }) }); } catch (err) { next(err); }
});

router.get('/:id', requirePermission('topology.view'), async (req, res, next) => {
  try { res.json({ data: await incidents.get(req.orgId, req.params.id) }); } catch (err) { next(err); }
});

// Close with what was done. The comment is required.
router.post('/:id/close', requirePermission('devices.update'), async (req, res, next) => {
  try { res.json({ data: await incidents.close(req.orgId, req.params.id, req.user?.id, req.body?.comment) }); } catch (err) { next(err); }
});

// Approve (optionally edited) or discard the closing message to one customer.
router.post('/:id/reports/:reportId/send', requirePermission('devices.update'), async (req, res, next) => {
  try { res.json({ data: await notices.approve(req.orgId, req.params.id, req.params.reportId, req.user?.id, req.body?.text, req.body?.lang) }); } catch (err) { next(err); }
});

// The draft as its reviewer should read it: in their language (?lang=), next
// to what the customer will receive.
router.get('/:id/reports/:reportId/draft', requirePermission('devices.update'), async (req, res, next) => {
  try { res.json({ data: await notices.review(req.orgId, req.params.id, req.params.reportId, req.query.lang) }); } catch (err) { next(err); }
});

router.post('/:id/reports/:reportId/discard', requirePermission('devices.update'), async (req, res, next) => {
  try { res.json({ data: await notices.discard(req.orgId, req.params.id, req.params.reportId, req.user?.id) }); } catch (err) { next(err); }
});

module.exports = router;
