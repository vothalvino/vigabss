// =============================================================================
// VigaBSS 5.0 — custom menus and menu templates
// =============================================================================
// /menus/mine is each staff user's own sidebar arrangement: no permission is
// needed to read or change it, since it only reorders pages the person can
// already open. Templates need menu_templates.manage.
// A menu never grants access; see services/menuService.js.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const menus = require('../services/menuService');

const router = Router();
router.use(authenticate);
router.use(orgScope);

const manage = requirePermission('menu_templates.manage');

router.get('/mine', async (req, res, next) => {
  try { res.json({ data: await menus.mine(req.orgId, req.user.id) }); } catch (err) { next(err); }
});

router.put('/mine', async (req, res, next) => {
  try { res.json({ data: await menus.saveMine(req.orgId, req.user.id, req.body?.layout) }); } catch (err) { next(err); }
});

router.delete('/mine', async (req, res, next) => {
  try { res.json({ data: await menus.resetMine(req.orgId, req.user.id) }); } catch (err) { next(err); }
});

router.get('/templates', manage, async (req, res, next) => {
  try { res.json({ data: await menus.listTemplates(req.orgId) }); } catch (err) { next(err); }
});

// The user groups and people a template can be given to.
router.get('/templates/audience', manage, async (req, res, next) => {
  try { res.json({ data: await menus.audience(req.orgId) }); } catch (err) { next(err); }
});

router.post('/templates', manage, async (req, res, next) => {
  try { res.status(201).json({ data: await menus.createTemplate(req.orgId, req.user.id, req.body) }); } catch (err) { next(err); }
});

router.put('/templates/:id', manage, async (req, res, next) => {
  try { res.json({ data: await menus.updateTemplate(req.orgId, req.params.id, req.body) }); } catch (err) { next(err); }
});

router.delete('/templates/:id', manage, async (req, res, next) => {
  try { res.json({ data: await menus.deleteTemplate(req.orgId, req.params.id) }); } catch (err) { next(err); }
});

// Who gets the template: replaces the list.
router.put('/templates/:id/assignments', manage, async (req, res, next) => {
  try { res.json({ data: await menus.assignTemplate(req.orgId, req.params.id, req.body) }); } catch (err) { next(err); }
});

module.exports = router;
