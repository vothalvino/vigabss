// =============================================================================
// OpenAPI paths of the reseller program, phase 5b (migration 009): "Reportar
// falla" tickets from the reseller app and the remote signing link. Merged
// into the spec by src/utils/openapi.js; routes in
// src/routes/resellerAppSupport.js, serviceOrders.js and publicSigning.js.
// =============================================================================

const nullableString = (format) => (format ? { type: ['string', 'null'], format } : { type: ['string', 'null'] });

function obj(properties, required = Object.keys(properties)) {
  return { type: 'object', required, properties };
}
function ok(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}
function err(description) {
  return {
    description,
    content: { 'application/json': { schema: obj({
      error: obj({
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      }, ['code', 'message']),
    }) } },
  };
}
function body(schema, description) {
  return { description, required: true, content: { 'application/json': { schema } } };
}
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'integer' } });
const tokenParam = () => ({ name: 'token', in: 'path', required: true, description: '<organization id>-<43 base64url characters>', schema: { type: 'string', maxLength: 64 } });
const pageParam = () => ({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } });
const limitParam = () => ({ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } });
const security = [{ bearerAuth: [] }];
const CATEGORIES = ['technical', 'billing', 'installation', 'general'];
const TICKET_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];

function resellerTicketSchema() {
  return obj({
    id: { type: 'integer' },
    client_id: { type: 'integer' },
    client_name: nullableString(),
    subject: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    status: { type: 'string', enum: TICKET_STATUSES },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: nullableString('date-time'),
    resolved_at: nullableString('date-time'),
  });
}

function linkSchema() {
  return obj({
    id: { type: 'integer' },
    channel: { type: 'string', enum: ['email', 'sms', 'copy'] },
    destination_masked: nullableString(),
    expires_at: { type: 'string', format: 'date-time' },
  });
}

function messageSchema() {
  return {
    type: ['object', 'null'],
    description: 'The queued email or SMS; skipped with a code when the organization or the customer\'s preferences block it',
    required: ['queued', 'skipped', 'code'],
    properties: { queued: { type: 'boolean' }, skipped: { type: 'boolean' }, code: nullableString() },
  };
}

function staffLinkRowSchema() {
  return obj({
    id: { type: 'integer' },
    channel: { type: 'string', enum: ['email', 'sms', 'copy'] },
    destination_masked: nullableString(),
    requested_by: { type: ['integer', 'null'] },
    requested_by_reseller_id: { type: ['integer', 'null'] },
    expires_at: { type: 'string', format: 'date-time' },
    revoked_at: nullableString('date-time'),
    completed_at: nullableString('date-time'),
    last_opened_at: nullableString('date-time'),
    created_at: { type: 'string', format: 'date-time' },
  });
}

function publicDocumentSchema() {
  return obj({
    id: { type: 'integer' },
    template_type: { type: 'string', enum: ['installation_authorization', 'activation_contract', 'service_acknowledgment', 'equipment_comodato', 'custom'] },
    title: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'signed'] },
    signed_at: nullableString('date-time'),
    mx_contract_environment: { type: ['string', 'null'], enum: ['sandbox', 'production', null] },
    rendered_body: { type: ['string', 'null'], description: 'The frozen Markdown text of a pending document' },
    signable: { type: 'boolean' },
    waiting_for_visit: { type: 'boolean', description: 'The activation contract or acknowledgment: signable only while the installation visit is in progress' },
    captures_communication_choices: { type: 'boolean' },
  });
}

function supportPaths() {
  return {
    '/reseller-app/tickets': {
      get: { tags: ['Reseller App'], summary: 'Faults the reseller subtree reported ("Reportar falla"), newest first, with their status; optionally of one client. Needs reseller_app.tickets', operationId: 'listResellerAppTickets', security, parameters: [{ name: 'client_id', in: 'query', required: false, schema: { type: 'integer' } }, pageParam(), limitParam()], responses: { 200: ok('Tickets', obj({ data: { type: 'array', items: resellerTicketSchema() }, meta: obj({ total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } }) })), 403: err('Not a reseller account, or no reseller_app.tickets'), 404: err('Client not found in the reseller subtree') } },
      post: { tags: ['Reseller App'], summary: "Report a fault for a client of the subtree: a ticket in the ISP's queue (source reseller); staff are notified as for any new ticket, the customer is not. At most 30 per reseller in 24 hours. Needs reseller_app.tickets", operationId: 'createResellerAppTicket', security, requestBody: body(obj({ client_id: { type: 'integer', minimum: 1 }, subject: { type: 'string', minLength: 3, maxLength: 150 }, description: { type: 'string', minLength: 5, maxLength: 2000 }, category: { type: 'string', enum: CATEGORIES } }, ['client_id', 'subject', 'description']), 'The fault'), responses: { 201: ok('Ticket', obj({ data: resellerTicketSchema() })), 403: err('Not a reseller account, or no reseller_app.tickets'), 404: err('Client not found in the reseller subtree'), 422: err('Validation failed'), 429: err('TOO_MANY_TICKETS') } },
    },
    '/reseller-app/leads/{id}/signing': {
      get: { tags: ['Reseller App'], summary: "The signing state of a lead's new installation: no_installation, not_started, pending, signed or installed; the document counts, whether a link can be sent, and the last link (without the link itself). Needs reseller_app.signup", operationId: 'getResellerAppLeadSigning', security, parameters: [idParam()], responses: { 200: ok('Signing state', obj({ data: obj({ state: { type: 'string', enum: ['no_installation', 'not_started', 'pending', 'signed', 'installed'] }, pending_documents: { type: 'integer' }, signed_documents: { type: 'integer' }, can_send: { type: 'boolean' }, contacts: { type: ['object', 'null'], properties: { email: { type: 'boolean' }, phone: { type: 'boolean' } } }, last_link: { type: ['object', 'null'], properties: { channel: { type: 'string' }, destination_masked: nullableString(), created_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, completed_at: nullableString('date-time'), revoked_at: nullableString('date-time'), opened: { type: 'boolean' } } } }) })), 403: err('Not a reseller account, or no reseller_app.signup'), 404: err('Lead not found in the reseller subtree') } },
    },
    '/reseller-app/leads/{id}/signing-link': {
      post: { tags: ['Reseller App'], summary: 'Ask the ISP to send the customer of a lead the link to sign its installation documents, to its email or phone on file. The reseller never receives the link. Needs reseller_app.signup', operationId: 'sendResellerAppLeadSigningLink', security, parameters: [idParam()], requestBody: body(obj({ channel: { type: 'string', enum: ['email', 'sms'] } }), 'Where to send it'), responses: { 201: ok('Sent', obj({ data: obj({ link: linkSchema(), message: messageSchema() }) })), 403: err('Not a reseller account, or no reseller_app.signup'), 404: err('Lead not found in the reseller subtree'), 409: err('ORDER_NOT_SIGNABLE or NO_PENDING_DOCUMENTS'), 422: err('NO_EMAIL, NO_PHONE or an unknown channel'), 502: err('MESSAGE_NOT_QUEUED: nothing was sent') } },
    },
    '/service-orders/{id}/signing-links': {
      get: { tags: ['Service Orders'], summary: 'The remote signing links of a service order, newest first (never the tokens). signed_documents.view', operationId: 'listServiceOrderSigningLinks', security, parameters: [idParam()], responses: { 200: ok('Links', obj({ data: { type: 'array', items: staffLinkRowSchema() } })), 404: err('Service order not found') } },
      post: { tags: ['Service Orders'], summary: "Send the customer of a new installation in process a link to read and sign its pending documents on its own device: email or sms to the contact on file, or copy (the link is returned for staff to hand over). It replaces the order's earlier links and expires (SIGNING_LINK_TTL_HOURS, default 72). The on-site rules hold: the activation contract can be signed only while the installation visit is in progress. signed_documents.create", operationId: 'createServiceOrderSigningLink', security, parameters: [idParam()], requestBody: body(obj({ channel: { type: 'string', enum: ['email', 'sms', 'copy'] } }), 'How the customer gets it'), responses: { 201: ok('Link', obj({ data: obj({ link: linkSchema(), url: { type: ['string', 'null'], description: 'Only for channel copy' }, message: messageSchema() }) })), 404: err('Service order not found'), 409: err('ORDER_NOT_SIGNABLE or NO_PENDING_DOCUMENTS'), 422: err('NO_EMAIL, NO_PHONE or an unknown channel'), 502: err('MESSAGE_NOT_QUEUED: nothing was sent') } },
    },
    '/service-orders/{id}/signing-links/revoke': {
      post: { tags: ['Service Orders'], summary: "End the order's live signing links. signed_documents.create", operationId: 'revokeServiceOrderSigningLinks', security, parameters: [idParam()], responses: { 200: ok('Revoked', obj({ data: obj({ revoked: { type: 'integer' } }) })), 404: err('Service order not found') } },
    },
    '/public/signing/{token}': {
      get: { tags: ['Public'], summary: 'No session: the documents a remote signing link opens, for the customer to read and sign; marks the link opened', operationId: 'getPublicSigning', security: [], parameters: [tokenParam()], responses: { 200: ok('Documents', obj({ data: obj({ organization_name: nullableString(), customer_first_name: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' }, documents: { type: 'array', items: publicDocumentSchema() }, communication_contacts: obj({ email: { type: 'boolean' }, phone: { type: 'boolean' } }), privacy_notice: { type: ['object', 'null'], properties: { version: { type: 'string' }, content: { type: 'string' }, hash: { type: 'string' } } } }) })), 404: err('LINK_NOT_FOUND'), 410: err('LINK_EXPIRED, LINK_REVOKED or LINK_COMPLETED'), 429: err('Too many requests') } },
    },
    '/public/signing/{token}/documents/{docId}/sign': {
      post: { tags: ['Public'], summary: 'No session: the customer signs one document of the link (signer name, the drawn signature, accept: true, and the communication choices with the privacy notice version and hash the first time a handoff document is signed). Recorded as a self-service signature with the link', operationId: 'signPublicDocument', security: [], parameters: [tokenParam(), idParam('docId')], requestBody: body(obj({ signer_name: { type: 'string', minLength: 2, maxLength: 200 }, signature_image: { type: 'string', description: 'PNG or JPEG data URL, at most about 500 KB' }, accept: { type: 'boolean' }, communication_opt_ins: { type: 'object', properties: { email: { type: 'boolean' }, sms: { type: 'boolean' }, whatsapp: { type: 'boolean' } } }, communication_choices_confirmed: { type: 'boolean' }, privacy_notice_version: { type: 'string' }, privacy_notice_hash: { type: 'string' } }, ['signer_name', 'signature_image', 'accept']), 'The signature'), responses: { 200: ok('Signed', obj({ data: obj({ document: obj({ id: { type: 'integer' }, status: { type: 'string' }, signed_at: nullableString('date-time'), title: { type: 'string' } }), remaining: { type: 'integer', description: 'Documents of the link still pending' } }) })), 404: err('LINK_NOT_FOUND or DOCUMENT_NOT_FOUND'), 410: err('LINK_EXPIRED, LINK_REVOKED or LINK_COMPLETED'), 422: err('ACCEPT_REQUIRED, or the signing rules refused it (for example the installation visit has not started)'), 429: err('Too many requests') } },
    },
  };
}

module.exports = { supportPaths };
