// =============================================================================
// VigaBSS 5.0 — Payment Gateway Routes
// =============================================================================

const { Router } = require('express');
const PaymentGateway = require('../models/PaymentGateway');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createPaymentGateway, updatePaymentGateway } = require('../middleware/schemas/paymentGateways');
const { sealSecretFields } = require('../utils/sealSecrets');

const router = Router();

// Never expose encrypted gateway credentials in any response body. secret_key_encrypted
// and webhook_secret_encrypted hold ciphertext at rest — but src/utils/encryption.js's
// encrypt()/decrypt() are transparent no-ops when ENCRYPTION_KEY is unset (dev/test/
// misconfigured prod), in which case these columns hold PLAINTEXT secrets. The UI only
// needs to know whether a secret is configured, not its value — expose booleans instead
// so it can render a "configured" badge. Mirrors src/routes/nas.js's redactNas.
function redactPaymentGateway(row) {
  if (!row || typeof row !== 'object') return row;
  const rest = { ...row };
  const hasSecretKey = Boolean(rest.secret_key_encrypted);
  const hasWebhookSecret = Boolean(rest.webhook_secret_encrypted);
  delete rest.secret_key_encrypted;
  delete rest.webhook_secret_encrypted;
  return { ...rest, has_secret_key: hasSecretKey, has_webhook_secret: hasWebhookSecret };
}

// Deleting a gateway is a deactivation: soft-delete alone left status
// 'active', and the money paths filter on status. Stop it, and stop every
// scheduled retry that would charge a card stored at this gateway.
async function deactivateGatewayBeforeDelete(gateway, req, exec) {
  await exec(
    `UPDATE payment_gateways SET status = 'inactive', is_default = 0
      WHERE id = ? AND organization_id = ?`,
    [gateway.id, req.orgId],
  );
  await exec(
    `UPDATE payment_retries pr
       JOIN recurring_payment_profiles rp ON rp.id = pr.recurring_profile_id
        SET pr.status = 'cancelled', pr.completed_at = NOW(), pr.next_retry_at = NULL,
            pr.last_error = 'Payment gateway deleted'
      WHERE rp.payment_gateway_id = ? AND pr.organization_id = ?
        AND pr.status IN ('pending', 'processing')`,
    [gateway.id, req.orgId],
  );
}

const ctrl = crudController(PaymentGateway, {
  serialize: redactPaymentGateway,
  beforeDelete: deactivateGatewayBeforeDelete,
});

router.use(authenticate);
router.use(orgScope);

router.get('/', requirePermission('payment_gateways.view'), ctrl.list);
router.get('/:id', requirePermission('payment_gateways.view'), ctrl.get);
// secret_key_encrypted is NOT NULL; a gateway with no secret (manual) stores ''.
const sealGatewaySecrets = sealSecretFields(
  { secret_key: 'secret_key_encrypted', webhook_secret: 'webhook_secret_encrypted' },
  { defaults: { secret_key_encrypted: '' } },
);

router.post('/', requirePermission('payment_gateways.create'), validate(createPaymentGateway), sealGatewaySecrets, ctrl.create);
router.put('/:id', requirePermission('payment_gateways.update'), validate(updatePaymentGateway), sealGatewaySecrets, ctrl.update);
router.delete('/:id', requirePermission('payment_gateways.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('payment_gateways.update'), ctrl.restore);

module.exports = router;
