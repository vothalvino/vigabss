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
const paymentGatewayService = require('../services/paymentGatewayService');
const { ValidationError } = require('../utils/errors');
const { installPaymentMode, stripeKeyMode, environmentForMode } = require('../utils/paymentMode');

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

// Gateway problems an admin can act on (BIL-32). Before /:id.
router.get('/webhook-events', requirePermission('payment_gateways.view'), async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.listWebhookEvents(req.orgId, req.query));
  } catch (err) { next(err); }
});
router.get('/unsettled-transactions', requirePermission('payment_gateways.view'), async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.listUnsettledTransactions(req.orgId, req.query));
  } catch (err) { next(err); }
});
router.get('/refunded-with-live-rep', requirePermission('payment_gateways.view'), async (req, res, next) => {
  try {
    res.json(await paymentGatewayService.listRefundedPaymentsWithLiveRep(req.orgId, req.query));
  } catch (err) { next(err); }
});

// Whether this install takes test or live keys (PAYMENT_MODE). Before /:id.
router.get('/mode', requirePermission('payment_gateways.view'), (_req, res) => {
  res.json({ data: { payment_mode: installPaymentMode() } });
});

router.get('/:id', requirePermission('payment_gateways.view'), ctrl.get);
// secret_key_encrypted is NOT NULL; a gateway with no secret (manual) stores ''.
const sealGatewaySecrets = sealSecretFields(
  { secret_key: 'secret_key_encrypted', webhook_secret: 'webhook_secret_encrypted' },
  { defaults: { secret_key_encrypted: '' } },
);

// A Stripe gateway's environment is read from its key, never chosen, and the
// key must belong to this install's payment mode (src/utils/paymentMode.js).
// Runs before the key is sealed. Other providers' keys do not say which side
// they are on, so their environment stays the label the admin gives it.
async function enforceStripeKeyMode(req, _res, next) {
  try {
    const body = req.body || {};
    const key = typeof body.secret_key === 'string' ? body.secret_key.trim() : '';
    if (req.method !== 'POST' && !key && body.environment === undefined && body.provider === undefined) return next();
    const provider = body.provider
      ?? (await PaymentGateway.findByIdOrFail(req.params.id, req.orgId)).provider;
    if (provider !== 'stripe') return next();
    if (!key) {
      // No new key: the stored one still decides, so the label cannot move.
      delete body.environment;
      return next();
    }
    const keyMode = stripeKeyMode(key);
    if (!keyMode) {
      throw new ValidationError('That is not a Stripe secret key', [{
        field: 'secret_key', message: 'A Stripe secret key starts with sk_test_ or sk_live_ (or rk_ for a restricted key)',
      }]);
    }
    const mode = installPaymentMode();
    if (keyMode !== mode) {
      throw new ValidationError(
        mode === 'test'
          ? 'This server is in test mode and accepts only Stripe test keys'
          : 'This server takes real payments and accepts only Stripe live keys',
        [{ field: 'secret_key', message: `Expected a ${mode} key (sk_${mode}_…), got a ${keyMode} key` }],
      );
    }
    body.environment = environmentForMode(keyMode);
    return next();
  } catch (err) { return next(err); }
}

router.post('/', requirePermission('payment_gateways.create'), validate(createPaymentGateway, { strip: false }), enforceStripeKeyMode, sealGatewaySecrets, ctrl.create);
router.put('/:id', requirePermission('payment_gateways.update'), validate(updatePaymentGateway, { strip: false }), enforceStripeKeyMode, sealGatewaySecrets, ctrl.update);
// Ask the provider whether the stored key works. Changes nothing.
router.post('/:id/test', requirePermission('payment_gateways.update'), async (req, res, next) => {
  try {
    res.json({ data: await paymentGatewayService.testGatewayConnection(req.params.id, req.orgId) });
  } catch (err) { next(err); }
});
router.delete('/:id', requirePermission('payment_gateways.delete'), ctrl.destroy);
router.post('/:id/restore', requirePermission('payment_gateways.update'), ctrl.restore);

module.exports = router;
