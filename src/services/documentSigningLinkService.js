// =============================================================================
// VigaBSS 5.0 — Remote signing links (reseller program, phase 5b, migration 009)
// =============================================================================
// The ISP sends a customer a link to read and sign, on its own device, the
// pending legal documents of its new installation (the installation
// authorization, the PROFECO-registered activation contract, a comodato
// annex): the same documents and the same signing rules as on site
// (legalDocumentService.sign), with captured_by NULL (self-service) and the
// link recorded in signed_documents.signing_link_id.
//
//   create   staff (signed_documents.create) for a service order, or a
//            reseller (reseller_app.signup) for its own lead: the link goes
//            to the customer's email or phone on file through the message
//            outbox (sensitive: its body is cleared once sent). Staff may
//            also take a copy to hand over themselves; a reseller never sees
//            the link. A new link revokes the order's earlier ones.
//   view     the public page: the organization, the customer's first name,
//            the documents and, for each pending one, whether it can be
//            signed now (the activation contract and the service
//            acknowledgment only while the installation visit is in
//            progress, as on site)
//   sign     one document, by the customer, through the link
//
// The token is "<organization id>-<43 random base64url characters>": the
// prefix chooses the tenant database (isolated organizations), and only the
// SHA-256 of the whole token is stored. Links expire (SIGNING_LINK_TTL_HOURS,
// default 72) and end when every document is signed.
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const config = require('../config');
const logger = require('../utils/logger').child({ service: 'documentSigningLink' });
const { requireOrgId } = require('../utils/requireOrgId');
const { AppError, NotFoundError, ValidationError } = require('../utils/errors');
const legalDocumentService = require('./legalDocumentService');
const privacyNoticeService = require('./privacyNoticeService');
const messageOutbox = require('./messageOutbox');

const CHANNELS = ['email', 'sms', 'copy'];
const HANDOFF_TYPES = ['activation_contract', 'service_acknowledgment'];
const TOKEN = /^(\d{1,12})-([A-Za-z0-9_-]{43})$/;

function ttlHours() {
  const raw = Number.parseInt(process.env.SIGNING_LINK_TTL_HOURS, 10);
  return Number.isSafeInteger(raw) && raw > 0 && raw <= 24 * 30 ? raw : 72;
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function coded(err, code) {
  err.code = code;
  return err;
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}***@${domain}`;
}

function maskPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 4 ? `*** *** ${digits.slice(-4)}` : '***';
}

/** The first word of a name, for the public page's greeting. */
function firstName(name) {
  const word = String(name || '').trim().split(/\s+/)[0] || '';
  return word.slice(0, 40);
}

function linkUrl(token) {
  return `${String(config.appUrl).replace(/\/+$/, '')}/firmar/${token}`;
}

/** The order, its customer and its documents; refuses one that cannot be signed. */
async function signableOrder(exec, orgId, serviceOrderId) {
  const [orders] = await exec(
    `SELECT so.id, so.order_number, so.order_type, so.status, so.client_id, so.lead_id,
            c.name AS client_name, c.email AS client_email, c.phone AS client_phone
       FROM service_orders so
       JOIN clients c ON c.id = so.client_id AND c.organization_id = so.organization_id AND c.deleted_at IS NULL
      WHERE so.id = ? AND so.organization_id = ? AND so.deleted_at IS NULL`,
    [serviceOrderId, orgId],
  );
  const order = orders && orders[0];
  if (!order) throw new NotFoundError('Service order');
  if (order.order_type !== 'new_install' || order.status !== 'in_process') {
    throw coded(new AppError('Documents are signed while a new installation is in process', 409, 'ORDER_NOT_SIGNABLE'), 'ORDER_NOT_SIGNABLE');
  }
  const [pending] = await exec(
    `SELECT COUNT(*) AS n FROM signed_documents
      WHERE organization_id = ? AND service_order_id = ? AND client_id = ? AND status = 'pending' AND deleted_at IS NULL`,
    [orgId, order.id, order.client_id],
  );
  if (!(Number(pending && pending[0] ? pending[0].n : 0) > 0)) {
    throw coded(new AppError('The installation has no document left to sign', 409, 'NO_PENDING_DOCUMENTS'), 'NO_PENDING_DOCUMENTS');
  }
  return order;
}

/**
 * Create a link for a service order and send it (or hand it to staff).
 * @returns {Promise<{link: object, url: string|null, message: object|null}>}
 */
async function create({ orgId, serviceOrderId, channel, requestedBy, resellerId = null }) {
  requireOrgId(orgId, 'documentSigningLinkService.create');
  if (!CHANNELS.includes(channel) || (resellerId !== null && channel === 'copy')) {
    throw new ValidationError(resellerId !== null ? 'channel must be email or sms' : 'channel must be email, sms or copy');
  }
  const order = await signableOrder(db.query.bind(db), orgId, serviceOrderId);
  let destination = null;
  if (channel === 'email') {
    if (!order.client_email) throw coded(new ValidationError('The customer has no email on file'), 'NO_EMAIL');
    destination = maskEmail(order.client_email);
  }
  if (channel === 'sms') {
    if (!order.client_phone) throw coded(new ValidationError('The customer has no phone on file'), 'NO_PHONE');
    destination = maskPhone(order.client_phone);
  }

  const token = `${Number(orgId)}-${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + ttlHours() * 3600 * 1000);
  const conn = await db.getConnection();
  const exec = conn.execute.bind(conn);
  let linkId;
  try {
    await conn.beginTransaction();
    await exec(
      `/* includes deleted rows: a lock only, serializing the order's links */
       SELECT id FROM service_orders WHERE id = ? AND organization_id = ? FOR UPDATE`,
      [order.id, orgId],
    );
    await exec(
      `UPDATE document_signing_links SET revoked_at = CURRENT_TIMESTAMP
        WHERE organization_id = ? AND service_order_id = ? AND revoked_at IS NULL AND completed_at IS NULL`,
      [orgId, order.id],
    );
    const [res] = await exec(
      `INSERT INTO document_signing_links
         (organization_id, service_order_id, client_id, token_sha256, channel, destination_masked,
          requested_by, requested_by_reseller_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, order.id, order.client_id, sha256(token), channel, destination, requestedBy ?? null, resellerId, expiresAt],
    );
    linkId = Number(res.insertId);
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_rollbackErr) { /* keep the original error */ }
    throw err;
  } finally {
    conn.release();
  }

  const url = linkUrl(token);
  let message = null;
  if (channel !== 'copy') {
    const [[org]] = await db.query('SELECT name FROM organizations WHERE id = ? AND deleted_at IS NULL', [orgId]);
    const isp = (org && org.name) || 'Tu proveedor de internet';
    const greeting = firstName(order.client_name);
    const hours = ttlHours();
    const bodyText = channel === 'email'
      ? `Hola${greeting ? ` ${greeting}` : ''}:\n\n${isp} te envía los documentos de tu instalación de internet para que los leas y los firmes desde tu teléfono:\n\n${url}\n\nLa liga es personal y vence en ${hours} horas. Si no solicitaste este servicio, ignora este mensaje.\n\n${isp}`
      : `${isp}: lee y firma los documentos de tu instalación aquí: ${url} (vence en ${hours} h). Si no solicitaste el servicio, ignora este mensaje.`;
    try {
      message = await messageOutbox.enqueue({
        channel,
        organizationId: orgId,
        clientId: order.client_id,
        messageClass: 'transactional',
        recipient: channel === 'email' ? order.client_email : order.client_phone,
        subject: channel === 'email' ? `${isp}: firma los documentos de tu instalación` : null,
        bodyText,
        sourceType: 'document_signing_link',
        sourceId: linkId,
        dedupeKey: `document_signing_link:${linkId}`,
        sensitive: true,
      });
      if (message && message.id) {
        await db.query(
          'UPDATE document_signing_links SET message_outbox_id = ? WHERE id = ? AND organization_id = ?',
          [message.id, linkId, orgId],
        );
      }
    } catch (err) {
      logger.error({ err, linkId, orgId }, 'The signing link could not be queued');
      await db.query(
        'UPDATE document_signing_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?',
        [linkId, orgId],
      );
      throw coded(new AppError('The message could not be queued; nothing was sent', 502, 'MESSAGE_NOT_QUEUED'), 'MESSAGE_NOT_QUEUED');
    }
  }
  return {
    link: { id: linkId, channel, destination_masked: destination, expires_at: expiresAt.toISOString() },
    url: channel === 'copy' ? url : null,
    message: message ? { queued: Boolean(message.queued), skipped: Boolean(message.skipped), code: message.code ?? null } : null,
  };
}

/** The organization a token names, or null when it is not a token. */
function tokenOrg(token) {
  const m = TOKEN.exec(String(token || ''));
  return m ? Number(m[1]) : null;
}

/** The live link of a token, on the tenant context the caller set; 404 / 410. */
async function liveLink(orgId, token, { forUpdate = false, exec = db.query.bind(db) } = {}) {
  const [rows] = await exec(
    `SELECT * FROM document_signing_links
      WHERE organization_id = ? AND token_sha256 = ?
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [orgId, sha256(token)],
  );
  const link = rows && rows[0];
  if (!link) throw coded(new NotFoundError('Signing link'), 'LINK_NOT_FOUND');
  if (link.completed_at) throw coded(new AppError('Every document of this link is already signed', 410, 'LINK_COMPLETED'), 'LINK_COMPLETED');
  if (link.revoked_at) throw coded(new AppError('This link was replaced by a newer one', 410, 'LINK_REVOKED'), 'LINK_REVOKED');
  if (new Date(link.expires_at).getTime() <= Date.now()) {
    throw coded(new AppError('This link has expired; ask your provider for a new one', 410, 'LINK_EXPIRED'), 'LINK_EXPIRED');
  }
  return link;
}

/** Run `fn(orgId)` in the tenant context the token names; 404 for anything else. */
function withTokenTenant(token, fn) {
  const orgId = tokenOrg(token);
  if (!orgId) return Promise.reject(coded(new NotFoundError('Signing link'), 'LINK_NOT_FOUND'));
  return db.withTenantContext(orgId, () => fn(orgId));
}

async function linkDocuments(orgId, link) {
  const [docs] = await db.query(
    `SELECT d.id, d.template_type, d.title, d.status, d.rendered_body, d.signed_at, d.mx_contract_environment,
            d.communication_choices, wo.status AS work_order_status
       FROM signed_documents d
       LEFT JOIN work_orders wo ON wo.id = d.work_order_id AND wo.organization_id <=> d.organization_id
      WHERE d.organization_id = ? AND d.service_order_id = ? AND d.client_id = ?
        AND d.status IN ('pending', 'signed') AND d.deleted_at IS NULL
      ORDER BY FIELD(d.template_type, 'installation_authorization', 'activation_contract', 'equipment_comodato', 'service_acknowledgment', 'custom'), d.id`,
    [orgId, link.service_order_id, link.client_id],
  );
  return docs || [];
}

/** The public page of a link. */
async function view(token) {
  return withTokenTenant(token, async (orgId) => {
    const link = await liveLink(orgId, token);
    const [[org]] = await db.query('SELECT name FROM organizations WHERE id = ? AND deleted_at IS NULL', [orgId]);
    const [[client]] = await db.query(
      'SELECT name, email, phone FROM clients WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [link.client_id, orgId],
    );
    if (!client) throw coded(new NotFoundError('Signing link'), 'LINK_NOT_FOUND');
    const docs = await linkDocuments(orgId, link);
    const choicesRecorded = docs.some((d) => d.status === 'signed' && d.communication_choices);
    const needsChoices = docs.some((d) => d.status === 'pending' && HANDOFF_TYPES.includes(d.template_type)) && !choicesRecorded;
    const notice = needsChoices ? await privacyNoticeService.getNotice(orgId) : null;
    await db.query(
      'UPDATE document_signing_links SET last_opened_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?',
      [link.id, orgId],
    );
    return {
      organization_name: (org && org.name) || null,
      customer_first_name: firstName(client.name),
      expires_at: link.expires_at,
      documents: docs.map((d) => {
        const handoff = HANDOFF_TYPES.includes(d.template_type);
        const visitActive = ['in_progress', 'completed'].includes(d.work_order_status);
        return {
          id: Number(d.id),
          template_type: d.template_type,
          title: d.title,
          status: d.status,
          signed_at: d.signed_at ?? null,
          mx_contract_environment: d.mx_contract_environment ?? null,
          // The frozen text of a pending document; a signed one is in the portal.
          rendered_body: d.status === 'pending' ? d.rendered_body : null,
          signable: d.status === 'pending' && (!handoff || visitActive),
          waiting_for_visit: d.status === 'pending' && handoff && !visitActive,
          captures_communication_choices: d.status === 'pending' && handoff && !choicesRecorded,
        };
      }),
      communication_contacts: { email: Boolean(client.email), phone: Boolean(client.phone) },
      privacy_notice: notice ? { version: notice.version, content: notice.content, hash: notice.hash } : null,
    };
  });
}

/**
 * Sign one document through a link. The customer signs: captured_by stays
 * NULL and the link is recorded. Ends the link when nothing is left to sign.
 */
async function sign(token, documentId, body, { ip = null } = {}) {
  return withTokenTenant(token, async (orgId) => {
    const link = await liveLink(orgId, token);
    const id = Number(documentId);
    const [rows] = await db.query(
      `SELECT id, status FROM signed_documents
        WHERE id = ? AND organization_id = ? AND service_order_id = ? AND client_id = ? AND deleted_at IS NULL`,
      [id, orgId, link.service_order_id, link.client_id],
    );
    if (!rows || !rows[0]) throw coded(new NotFoundError('Document'), 'DOCUMENT_NOT_FOUND');
    if (body.accept !== true) {
      throw coded(new ValidationError('Confirm that you read the document and agree to sign it'), 'ACCEPT_REQUIRED');
    }
    const signed = await legalDocumentService.sign(id, {
      orgId,
      signerName: body.signer_name,
      signatureImage: body.signature_image,
      signedIp: ip,
      performedBy: null,
      communicationOptIns: body.communication_opt_ins,
      communicationChoicesConfirmed: body.communication_choices_confirmed,
      privacyNoticeVersion: body.privacy_notice_version,
      privacyNoticeHash: body.privacy_notice_hash,
      signingLinkId: link.id,
    });
    const [[left]] = await db.query(
      `SELECT COUNT(*) AS n FROM signed_documents
        WHERE organization_id = ? AND service_order_id = ? AND client_id = ? AND status = 'pending' AND deleted_at IS NULL`,
      [orgId, link.service_order_id, link.client_id],
    );
    const remaining = Number(left?.n) || 0;
    if (remaining === 0) {
      await db.query(
        'UPDATE document_signing_links SET completed_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND completed_at IS NULL',
        [link.id, orgId],
      );
    }
    return {
      orgId,
      linkId: Number(link.id),
      document: { id: Number(signed.id), status: signed.status, signed_at: signed.signed_at, title: signed.title },
      remaining,
    };
  });
}

/** The links of a service order, newest first, for staff (no token). */
async function listForOrder(orgId, serviceOrderId) {
  requireOrgId(orgId, 'documentSigningLinkService.listForOrder');
  const [rows] = await db.query(
    `SELECT id, channel, destination_masked, requested_by, requested_by_reseller_id, expires_at, revoked_at,
            completed_at, last_opened_at, created_at
       FROM document_signing_links
      WHERE organization_id = ? AND service_order_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20`,
    [orgId, serviceOrderId],
  );
  return rows || [];
}

/** Revoke the live links of a service order (staff). */
async function revokeForOrder(orgId, serviceOrderId) {
  requireOrgId(orgId, 'documentSigningLinkService.revokeForOrder');
  const [res] = await db.query(
    `UPDATE document_signing_links SET revoked_at = CURRENT_TIMESTAMP
      WHERE organization_id = ? AND service_order_id = ? AND revoked_at IS NULL AND completed_at IS NULL`,
    [orgId, serviceOrderId],
  );
  return Number(res?.affectedRows) || 0;
}

module.exports = {
  CHANNELS,
  create,
  view,
  sign,
  listForOrder,
  revokeForOrder,
  tokenOrg,
  maskEmail,
  maskPhone,
  ttlHours,
};
