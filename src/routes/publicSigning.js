// =============================================================================
// VigaBSS 5.0 — Public remote signing (reseller program, phase 5b, migration 009)
// =============================================================================
// No session: the link token is the credential (services/documentSigningLinkService.js).
// Mounted at /api/v1/public/signing behind the public rate limiter.
//
//  GET  /public/signing/:token                         the documents of the link
//  POST /public/signing/:token/documents/:docId/sign   the customer signs one
//
// A token that is malformed, unknown, expired, replaced or used up answers
// 404 or 410 with no detail about the installation. Responses are no-store.
// =============================================================================

const { Router } = require('express');
const { validate } = require('../middleware/validate');
const auditLog = require('../services/auditLog');
const links = require('../services/documentSigningLinkService');

const router = Router();

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const signSchema = {
  signer_name:                     { type: 'string', required: true, min: 2, max: 200 },
  signature_image:                 { type: 'string', required: true, max: 500000 },
  accept:                          { type: 'boolean', required: true },
  communication_opt_ins:           { type: 'object' },
  communication_choices_confirmed: { type: 'boolean' },
  privacy_notice_version:          { type: 'string', max: 100 },
  privacy_notice_hash:             { type: 'string', max: 128 },
};

// GET /public/signing/:token
router.get('/:token', async (req, res, next) => {
  try {
    res.json({ data: await links.view(req.params.token) });
  } catch (err) { next(err); }
});

// POST /public/signing/:token/documents/:docId/sign
router.post('/:token/documents/:docId/sign', validate(signSchema), async (req, res, next) => {
  try {
    const result = await links.sign(req.params.token, req.params.docId, req.body, { ip: req.ip || null });
    // The signature is committed; an audit failure must not answer an error.
    try {
      await auditLog.log({
        userId: null,
        organizationId: result.orgId,
        action: 'sign_remote',
        tableName: 'signed_documents',
        recordId: result.document.id,
        newValues: { signing_link_id: result.linkId, signer_name: String(req.body.signer_name).trim() }, // never the signature image
      });
    } catch (_auditErr) { /* logged by auditLog */ }
    res.json({ data: { document: result.document, remaining: result.remaining } });
  } catch (err) { next(err); }
});

module.exports = router;
