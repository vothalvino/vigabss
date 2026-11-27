// =============================================================================
// VigaBSS 5.0 — Invoice Settings Routes
// =============================================================================
// GET  /invoice-settings       — get branding settings for current org
// PUT  /invoice-settings       — upsert branding settings
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const invoiceSettingsService = require('../services/invoiceSettingsService');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// The settings with the prefix invoice numbers take now and the one they
// would take by default, so the page can show an example number.
async function withPrefix(orgId, settings) {
  const prefix = await invoiceSettingsService.numberPrefix(orgId);
  return { ...settings, number_prefix: prefix.chosen, default_number_prefix: prefix.fallback, effective_number_prefix: prefix.effective };
}

router.get('/',
  requirePermission('invoice_settings.view'),
  async (req, res, next) => {
    try {
      const settings = await invoiceSettingsService.getInvoiceSettings(req.orgId);
      res.json(await withPrefix(req.orgId, settings || {}));
    } catch (err) {
      next(err);
    }
  },
);

router.put('/',
  requirePermission('invoice_settings.update'),
  async (req, res, next) => {
    try {
      const settings = await invoiceSettingsService.upsertInvoiceSettings(
        req.orgId,
        req.body,
      );
      res.json(await withPrefix(req.orgId, settings));
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
