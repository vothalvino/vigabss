// =============================================================================
// VigaBSS 5.0 — Subscriber Certificate Routes
// =============================================================================
// Metadata registry for subscriber EAP-TLS certificates (§3.1 item 6).
// NOTE: VigaBSS is a metadata registry only — it does NOT generate or sign
// certificates. Certificate files are managed by an external CA (e.g.
// easy-rsa, step-ca, or a commercial CA). Only metadata (serial, fingerprint,
// validity dates) is stored here.
// =============================================================================

const { Router } = require('express');
const SubscriberCertificate = require('../models/SubscriberCertificate');
const Client = require('../models/Client');
const Radius = require('../models/Radius');
const { crudController } = require('../controllers/crudController');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const {
  createSubscriberCertificate,
  updateSubscriberCertificate,
  revokeSubscriberCertificate,
} = require('../middleware/schemas/subscriberCertificates');
const { ValidationError } = require('../utils/errors');

const router = Router();
const ctrl = crudController(SubscriberCertificate);

router.use(authenticate);
router.use(orgScope);

// client_id and radius_account_id reference other tenant-owned rows. The
// certificate pins TLS-Cert-Serial on that RADIUS account at the next sync, so
// a foreign id would attach (or, via PUT, move) a certificate onto another
// tenant's subscriber (TNB-08). validate() does not strip undeclared keys and
// both columns are fillable, so PUT is guarded too. When both are given the
// RADIUS account must belong to that client. 422 on any mismatch.
async function assertCertificateRefs(req, _res, next) {
  try {
    const { client_id: clientId, radius_account_id: radiusAccountId } = req.body || {};
    if (clientId !== undefined && clientId !== null) {
      const client = await Client.findById(clientId, req.orgId);
      if (!client) throw new ValidationError('client_id does not belong to this organization');
    }
    if (radiusAccountId !== undefined && radiusAccountId !== null) {
      const account = await Radius.findById(radiusAccountId, req.orgId);
      if (!account) throw new ValidationError('radius_account_id does not belong to this organization');
      if (clientId !== undefined && clientId !== null && Number(account.client_id) !== Number(clientId)) {
        throw new ValidationError('radius_account_id does not belong to client_id');
      }
    }
    return next();
  } catch (err) { return next(err); }
}

router.get('/', requirePermission('subscriber_certificates.view'), ctrl.list);
router.get('/:id', requirePermission('subscriber_certificates.view'), ctrl.get);
router.post('/', requirePermission('subscriber_certificates.create'), validate(createSubscriberCertificate), assertCertificateRefs, ctrl.create);
router.put('/:id', requirePermission('subscriber_certificates.update'), validate(updateSubscriberCertificate), assertCertificateRefs, ctrl.update);
router.delete('/:id', requirePermission('subscriber_certificates.revoke'), ctrl.destroy);

// List certificates for a specific RADIUS account
router.get('/radius-account/:radiusAccountId', requirePermission('subscriber_certificates.view'), async (req, res, next) => {
  try {
    // 404 unless the RADIUS account belongs to the caller's org (Radius.findById
    // scopes through the owning client).
    await Radius.findByIdOrFail(req.params.radiusAccountId, req.orgId);
    const certs = await SubscriberCertificate.findByRadiusAccount(req.params.radiusAccountId, req.orgId);
    res.json({ data: certs });
  } catch (err) {
    next(err);
  }
});

// List certificates for a specific client
router.get('/client/:clientId', requirePermission('subscriber_certificates.view'), async (req, res, next) => {
  try {
    await Client.findByIdOrFail(req.params.clientId, req.orgId);
    const certs = await SubscriberCertificate.findByClient(req.params.clientId, req.orgId);
    res.json({ data: certs });
  } catch (err) {
    next(err);
  }
});

// Revoke a certificate
router.post('/:id/revoke', requirePermission('subscriber_certificates.revoke'), validate(revokeSubscriberCertificate), async (req, res, next) => {
  try {
    const cert = await SubscriberCertificate.findByIdOrFail(req.params.id, req.orgId);
    if (cert.status === 'revoked') {
      return res.status(409).json({ error: 'Certificate is already revoked' });
    }
    await SubscriberCertificate.revoke(cert.id, req.orgId, req.body.revocation_reason);
    const updated = await SubscriberCertificate.findById(cert.id, req.orgId);
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
