// =============================================================================
// VigaBSS 5.0 — Recurring Payment Profile Routes
// =============================================================================

const { Router } = require('express');
const RecurringPaymentProfile = require('../models/RecurringPaymentProfile');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createRecurringPaymentProfile, updateRecurringPaymentProfile } = require('../middleware/schemas/recurringPaymentProfiles');

const router = Router();
// Deleting a saved card revokes it (soft-delete alone left status 'active',
// which is what autopay and retries filter on) and cancels its retries.
async function revokeProfileBeforeDelete(profile, req, exec) {
  await exec(
    `UPDATE recurring_payment_profiles SET status = 'revoked'
      WHERE id = ? AND organization_id <=> ?`,
    [profile.id, req.orgId],
  );
  await exec(
    `UPDATE payment_retries
        SET status = 'cancelled', completed_at = NOW(), next_retry_at = NULL,
            last_error = 'Payment method deleted'
      WHERE recurring_profile_id = ? AND status IN ('pending', 'processing')`,
    [profile.id],
  );
}

const ctrl = crudController(RecurringPaymentProfile, { beforeDelete: revokeProfileBeforeDelete });

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('recurring_payment_profiles.view'), ctrl.list);
router.get('/:id', requirePermission('recurring_payment_profiles.view'), ctrl.get);
router.post('/', requirePermission('recurring_payment_profiles.create'), validate(createRecurringPaymentProfile), ctrl.create);
router.put('/:id', requirePermission('recurring_payment_profiles.update'), validate(updateRecurringPaymentProfile), ctrl.update);
router.delete('/:id', requirePermission('recurring_payment_profiles.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('recurring_payment_profiles.update'), ctrl.restore);

module.exports = router;
