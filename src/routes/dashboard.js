// =============================================================================
// VigaBSS 5.0 — Dashboard Routes
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission, userHasPermission } = require('../middleware/rbac');
const { httpCache } = require('../middleware/httpCache');
const dashboardController = require('../controllers/dashboardController');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// Each block of the summary belongs to the permission that guards the data it
// counts. The caller gets the blocks it may read and null for the rest, and the
// cached copy is kept per set of blocks so one person's answer is never served
// to someone who holds less.
const SUMMARY_PERMISSIONS = Object.values(dashboardController.SUMMARY_BLOCKS);

async function summaryBlocks(req, _res, next) {
  try {
    const blocks = [];
    for (const [block, permission] of Object.entries(dashboardController.SUMMARY_BLOCKS)) {
      if (await userHasPermission(req, permission)) blocks.push(block);
    }
    req.summaryBlocks = blocks;
    next();
  } catch (err) {
    next(err);
  }
}

router.get(
  '/summary',
  requirePermission(...SUMMARY_PERMISSIONS),
  summaryBlocks,
  httpCache('dashboard_summary', 60, { vary: (req) => req.summaryBlocks.join(',') }),
  dashboardController.summary,
);
router.get('/revenue', requirePermission('invoices.view'), httpCache('dashboard_revenue', 300), dashboardController.revenue);
router.get('/mrr', requirePermission('invoices.view'), httpCache('dashboard_mrr', 300), dashboardController.mrr);
router.get('/device-health', requirePermission('devices.view'), httpCache('dashboard_device_health', 120), dashboardController.deviceHealth);
router.get('/overdue', requirePermission('invoices.view'), httpCache('dashboard_overdue', 60), dashboardController.overdue);
router.get('/throughput', requirePermission('devices.view'), dashboardController.throughput);
router.get('/live-sessions', requirePermission('connection_logs.view'), httpCache('dashboard_live_sessions', 30), dashboardController.liveSessions);
router.get('/sites-utilization', requirePermission('devices.view'), httpCache('dashboard_sites_util', 60), dashboardController.sitesUtilization);
router.get('/network-devices', requirePermission('devices.view'), httpCache('dashboard_network_devices', 60), dashboardController.networkDevices);

module.exports = router;
