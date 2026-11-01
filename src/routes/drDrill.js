// =============================================================================
// VigaBSS 5.0 — DR Drill Routes
// =============================================================================

const { Router } = require('express');
const fs = require('fs/promises');
const path = require('path');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const drDrillService = require('../services/drDrillService');
const { isInstallOperator, OPERATOR_ONLY_MESSAGE } = require('../services/installOperator');

const router = Router();

// The runbook ships with the install (repo docs/ is copied into the image);
// serving it from disk keeps the in-app copy version-matched to the code.
const RUNBOOK_PATH = path.join(__dirname, '..', '..', 'docs', 'dr-drill.md');

router.use(authenticate);

async function requireInstallOperator(req, res, next) {
  try {
    if (await isInstallOperator(req)) return next();
    return res.status(403).json({
      error: { code: 'INSTALL_OPERATOR_ONLY', message: OPERATOR_ONLY_MESSAGE },
    });
  } catch (err) { return next(err); }
}

// The drill log describes the whole installation (its backups, restore
// timings and last_error), not one organization, so a tenant's settings.view
// grant cannot authorize it. settings.view stays as defense in depth.
router.use(requireInstallOperator);

// GET /dr-drill/status
// Returns the latest drill log entry plus an overdue flag.
// Install operator only.
router.get('/status', requirePermission('settings.view'), async (req, res, next) => {
  try {
    const status = await drDrillService.getDrillStatus();
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
});

// GET /dr-drill/runbook
// The DR runbook document (docs/dr-drill.md) as markdown, rendered on the
// /dr-drill admin page. Same permission as the status view.
router.get('/runbook', requirePermission('settings.view'), async (req, res, next) => {
  try {
    const markdown = await fs.readFile(RUNBOOK_PATH, 'utf8');
    res.json({ data: { markdown } });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: { message: 'Runbook document not found on this install' } });
    }
    next(err);
  }
});

module.exports = router;
