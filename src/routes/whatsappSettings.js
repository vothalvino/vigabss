// =============================================================================
// VigaBSS 5.0 — WhatsApp connection settings routes
// =============================================================================
// GET  /whatsapp-settings       — the connection as configured: number ID,
//                                 business number, which secrets are set and
//                                 from where, the webhook URL to give Meta
// PUT  /whatsapp-settings       — partial update (per field: omit = keep,
//                                 "" or null = remove, value = replace)
// POST /whatsapp-settings/test  — ask Meta about the number with the token
//
// Install operator only. The connection is install-wide (an inbound message
// has no organization until its number is resolved), and it holds the token
// that sends messages as the business — a tenant admin must not read or
// replace it. Mounted behind adminIpAllowlist like the other install-level
// settings.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const whatsappSettings = require('../services/whatsappSettingsService');
const auditLog = require('../services/auditLog');
const { isInstallOperator, OPERATOR_ONLY_MESSAGE } = require('../services/installOperator');

const router = Router();
router.use(authenticate);

router.use(async (req, res, next) => {
  try {
    if (await isInstallOperator(req)) return next();
    return res.status(403).json({ error: { code: 'INSTALL_OPERATOR_ONLY', message: OPERATOR_ONLY_MESSAGE } });
  } catch (err) { return next(err); }
});

router.get('/', async (_req, res, next) => {
  try {
    await whatsappSettings.refresh();
    res.json({ data: whatsappSettings.getView() });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    let result;
    try {
      result = await whatsappSettings.save(body);
    } catch (err) {
      if (err.statusCode === 422) {
        return res.status(422).json({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
    if (result.changed.length) {
      await auditLog.log({
        userId: req.user.id,
        organizationId: req.orgId ?? req.user.organization_id ?? null,
        action: 'update',
        entityType: 'settings',
        // Field names only: three of these are secrets.
        summary: `WhatsApp connection settings changed: ${result.changed.join(', ')}`,
      });
    }
    return res.json({ data: whatsappSettings.getView() });
  } catch (err) { return next(err); }
});

router.post('/test', async (_req, res, next) => {
  try {
    await whatsappSettings.refresh();
    res.json({ data: await whatsappSettings.testConnection() });
  } catch (err) { next(err); }
});

module.exports = router;
