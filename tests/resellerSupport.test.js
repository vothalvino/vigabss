// =============================================================================
// Reseller program, phase 5b (migration 009): "Reportar falla" and the remote
// signing link
// =============================================================================
// A bound reseller user reports a fault for a client of its subtree (a ticket
// in the ISP's queue) and asks the ISP to send its lead's customer the link to
// sign the installation documents. Staff send (or copy) the link; the customer
// opens it without a session and signs on its own device, under the on-site
// signing rules (legalDocumentService.sign, spied here). The database is an
// in-memory fake.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((_orgId, fn) => fn()),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../src/services/businessEvents', () => ({
  emitTicketCreated: jest.fn(async () => {}),
  emitPaymentReceived: jest.fn(),
  emitContractSuspended: jest.fn(),
  emitContractRestored: jest.fn(),
  emitSuspensionWarning: jest.fn(),
  emitMaintenanceScheduled: jest.fn(),
  emitInvoiceCreated: jest.fn(),
}));

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const businessEvents = require('../src/services/businessEvents');
const legalDocumentService = require('../src/services/legalDocumentService');
const privacyNoticeService = require('../src/services/privacyNoticeService');
const messageOutbox = require('../src/services/messageOutbox');
const links = require('../src/services/documentSigningLinkService');
const app = require('../src/app');

const ORG = 1;
const USER = 7;
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

let state;
let binding;
let groupName;

function freshState() {
  return {
    resellers: {
      1: { id: 1, organization_id: ORG, parent_id: null, name: 'Tienda Lupita' },
      3: { id: 3, organization_id: ORG, parent_id: 1, name: 'Lupita Norte' },
      2: { id: 2, organization_id: ORG, parent_id: null, name: 'Papelería Sol' },
    },
    clients: {
      31: { id: 31, organization_id: ORG, name: 'Ana Ruiz López', email: 'ana@example.com', phone: '7225550001', reseller_id: 3, deleted_at: null },
      21: { id: 21, organization_id: ORG, name: 'María López', email: null, phone: null, reseller_id: 2, deleted_at: null },
    },
    leads: { 5: { id: 5, organization_id: ORG, reseller_id: 3, deleted_at: null }, 6: { id: 6, organization_id: ORG, reseller_id: 2, deleted_at: null } },
    orders: {
      70: { id: 70, organization_id: ORG, order_number: 'SO-70', order_type: 'new_install', status: 'in_process', client_id: 31, lead_id: 5, deleted_at: null },
      71: { id: 71, organization_id: ORG, order_number: 'SO-71', order_type: 'new_install', status: 'new', client_id: 21, lead_id: 6, deleted_at: null },
    },
    workOrders: { 90: { id: 90, organization_id: ORG, status: 'assigned' } },
    docs: {
      101: { id: 101, organization_id: ORG, service_order_id: 70, client_id: 31, work_order_id: 90, template_type: 'installation_authorization', title: 'Autorización de instalación', status: 'pending', rendered_body: '# Autorización', communication_choices: null, deleted_at: null },
      102: { id: 102, organization_id: ORG, service_order_id: 70, client_id: 31, work_order_id: 90, template_type: 'activation_contract', title: 'Contrato de adhesión', status: 'pending', rendered_body: '# Contrato', communication_choices: null, deleted_at: null },
      201: { id: 201, organization_id: ORG, service_order_id: 71, client_id: 21, work_order_id: null, template_type: 'installation_authorization', title: 'Otra', status: 'pending', rendered_body: 'x', communication_choices: null, deleted_at: null },
    },
    tickets: [],
    links: [],
    seq: { ticket: 500, link: 0 },
  };
}

function handle(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/FROM reseller_user_bindings b/.test(s)) return [binding ? [binding] : []];
  if (/JOIN roles g ON g\.id = u\.group_id/.test(s)) return [groupName ? [{ group_name: groupName }] : []];
  if (/FROM resellers WHERE organization_id = \? AND parent_id IN/.test(s)) {
    const parents = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => parents.includes(r.parent_id)).map((r) => ({ id: r.id }))];
  }
  if (/^SELECT name FROM resellers WHERE id = \?/.test(s)) return [[{ name: state.resellers[Number(params[0])]?.name }]];
  if (/^SELECT name FROM organizations WHERE id = \?/.test(s)) return [[{ name: 'ISP Ejemplo' }]];
  // --- tickets
  if (/FROM clients c WHERE c\.id = \? AND c\.organization_id = \? AND c\.deleted_at IS NULL AND c\.reseller_id IN/.test(s)) {
    const c = state.clients[Number(params[0])];
    const ids = params.slice(2).map(Number);
    return [c && ids.includes(c.reseller_id) ? [{ id: c.id, name: c.name }] : []];
  }
  if (/SELECT COUNT\(\*\) AS n FROM tickets WHERE organization_id = \? AND source = 'reseller' AND reseller_id = \?/.test(s)) {
    return [[{ n: state.tickets.filter((t) => t.reseller_id === Number(params[1])).length }]];
  }
  if (/^INSERT INTO tickets/.test(s)) {
    const [org, clientId, subject, description, notes, category, resellerId] = params;
    const t = { id: ++state.seq.ticket, organization_id: org, client_id: clientId, subject, description, notes, priority: 'medium', category, status: 'open', source: 'reseller', reseller_id: resellerId, created_at: new Date(), updated_at: null, resolved_at: null };
    state.tickets.push(t);
    return [{ insertId: t.id, affectedRows: 1 }];
  }
  if (/^SELECT \* FROM tickets WHERE id = \?/.test(s)) return [state.tickets.filter((t) => t.id === Number(params[0]))];
  if (/FROM tickets t JOIN clients c/.test(s)) {
    const n = (s.match(/\?/g) || []).length;
    const ids = params.slice(1, 1 + (n - 1) / 2).map(Number);
    const clientFilter = s.includes('t.client_id = ?') ? Number(params[params.length - 1]) : null;
    const rows = state.tickets.filter((t) => ids.includes(t.reseller_id) && ids.includes(state.clients[t.client_id]?.reseller_id)
      && (clientFilter === null || t.client_id === clientFilter))
      .map((t) => ({ ...t, client_name: state.clients[t.client_id].name }));
    if (/COUNT\(\*\)/.test(s)) return [[{ total: rows.length }]];
    return [rows];
  }
  // --- leads and their orders
  if (/^SELECT id FROM leads WHERE id = \?/.test(s)) {
    const l = state.leads[Number(params[0])];
    const ids = params.slice(2).map(Number);
    return [l && ids.includes(l.reseller_id) ? [{ id: l.id }] : []];
  }
  if (/FROM service_orders so LEFT JOIN clients c .* WHERE so\.organization_id = \? AND so\.lead_id = \?/.test(s)) {
    const o = Object.values(state.orders).find((x) => x.lead_id === Number(params[1]));
    if (!o) return [[]];
    const c = state.clients[o.client_id];
    return [[{ id: o.id, status: o.status, client_id: o.client_id, client_email: c?.email ?? null, client_phone: c?.phone ?? null }]];
  }
  if (/SUM\(status = 'pending'\), 0\) AS pending/.test(s)) {
    const docs = Object.values(state.docs).filter((d) => d.service_order_id === Number(params[1]));
    return [[{ pending: docs.filter((d) => d.status === 'pending').length, signed: docs.filter((d) => d.status === 'signed').length }]];
  }
  // --- signing links
  if (/^SELECT \* FROM `service_orders` WHERE id = \?/.test(s)) return [state.orders[Number(params[0])] ? [{ ...state.orders[Number(params[0])] }] : []];
  if (/FROM service_orders so JOIN clients c ON c\.id = so\.client_id/.test(s)) {
    const o = state.orders[Number(params[0])];
    if (!o) return [[]];
    const c = state.clients[o.client_id];
    return [[{ ...o, client_name: c.name, client_email: c.email, client_phone: c.phone }]];
  }
  if (/SELECT COUNT\(\*\) AS n FROM signed_documents WHERE organization_id = \? AND service_order_id = \? AND client_id = \? AND status = 'pending'/.test(s)) {
    return [[{ n: Object.values(state.docs).filter((d) => d.service_order_id === Number(params[1]) && d.client_id === Number(params[2]) && d.status === 'pending').length }]];
  }
  if (/SELECT id FROM service_orders WHERE id = \? AND organization_id = \? FOR UPDATE/.test(s)) return [[{ id: Number(params[0]) }]];
  if (/^UPDATE document_signing_links SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = \? AND service_order_id = \?/.test(s)) {
    let n = 0;
    for (const l of state.links) if (l.service_order_id === Number(params[1]) && !l.revoked_at && !l.completed_at) { l.revoked_at = new Date(); n += 1; }
    return [{ affectedRows: n }];
  }
  if (/^UPDATE document_signing_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = \?/.test(s)) {
    const l = state.links.find((x) => x.id === Number(params[0]));
    if (l) l.revoked_at = new Date();
    return [{ affectedRows: l ? 1 : 0 }];
  }
  if (/^INSERT INTO document_signing_links/.test(s)) {
    const [org, orderId, clientId, tokenSha, channel, destination, requestedBy, resellerId, expiresAt] = params;
    const l = { id: ++state.seq.link, organization_id: org, service_order_id: orderId, client_id: clientId, token_sha256: tokenSha, channel, destination_masked: destination, requested_by: requestedBy, requested_by_reseller_id: resellerId, expires_at: expiresAt, revoked_at: null, completed_at: null, last_opened_at: null, message_outbox_id: null, created_at: new Date() };
    state.links.push(l);
    return [{ insertId: l.id, affectedRows: 1 }];
  }
  if (/^UPDATE document_signing_links SET message_outbox_id = \?/.test(s)) {
    const l = state.links.find((x) => x.id === Number(params[1]));
    if (l) l.message_outbox_id = params[0];
    return [{ affectedRows: 1 }];
  }
  if (/^SELECT \* FROM document_signing_links WHERE organization_id = \? AND token_sha256 = \?/.test(s)) {
    return [state.links.filter((l) => l.organization_id === Number(params[0]) && l.token_sha256 === params[1])];
  }
  if (/^UPDATE document_signing_links SET last_opened_at/.test(s)) {
    const l = state.links.find((x) => x.id === Number(params[0]));
    if (l) l.last_opened_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/^UPDATE document_signing_links SET completed_at/.test(s)) {
    const l = state.links.find((x) => x.id === Number(params[0]));
    if (l && !l.completed_at) l.completed_at = new Date();
    return [{ affectedRows: 1 }];
  }
  if (/FROM document_signing_links WHERE organization_id = \? AND service_order_id = \? ORDER BY/.test(s)) {
    const cols = s.match(/^SELECT (.+?) FROM document_signing_links/)[1].split(',').map((c) => c.trim());
    return [state.links.filter((l) => l.service_order_id === Number(params[1])).slice().reverse()
      .map((l) => Object.fromEntries(cols.map((c) => [c, l[c]])))];
  }
  if (/^SELECT name, email, phone FROM clients WHERE id = \?/.test(s)) {
    const c = state.clients[Number(params[0])];
    return [c ? [{ name: c.name, email: c.email, phone: c.phone }] : []];
  }
  if (/FROM signed_documents d LEFT JOIN work_orders wo/.test(s)) {
    return [Object.values(state.docs)
      .filter((d) => d.service_order_id === Number(params[1]) && d.client_id === Number(params[2]) && ['pending', 'signed'].includes(d.status))
      .map((d) => ({ ...d, signed_at: null, mx_contract_environment: 'sandbox', work_order_status: state.workOrders[d.work_order_id]?.status ?? null }))];
  }
  if (/^SELECT id, status FROM signed_documents WHERE id = \?/.test(s)) {
    const d = state.docs[Number(params[0])];
    return [d && d.service_order_id === Number(params[2]) && d.client_id === Number(params[3]) ? [{ id: d.id, status: d.status }] : []];
  }
  return [[]];
}

const mockQuery = jest.fn(async (sql, params) => handle(sql, params));

function tokenFor(role) {
  return jwt.sign({ sub: USER, email: `${role}@example.com`, role, orgId: ORG }, config.jwt.secret, { expiresIn: '1h' });
}
function asReseller(resellerId = 1, permissions = ['reseller_app.use', 'reseller_app.signup', 'reseller_app.tickets']) {
  groupName = 'reseller_admin';
  binding = { reseller_id: resellerId, live_reseller_id: resellerId, reseller_name: state.resellers[resellerId].name };
  User.findById.mockResolvedValue({ id: USER, email: 'r@example.com', status: 'active', role: 'billing', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('billing');
}
function asStaff(permissions = ['signed_documents.view', 'signed_documents.create', 'service_orders.view']) {
  groupName = 'admin';
  binding = undefined;
  User.findById.mockResolvedValue({ id: USER, email: 'a@example.com', status: 'active', role: 'support', organization_id: ORG });
  User.getPermissions.mockResolvedValue(permissions);
  return tokenFor('support');
}
const auth = (r, token) => r.set('Authorization', `Bearer ${token}`);
const get = (p, token) => (token ? auth(request(app).get(`/api/v1${p}`), token) : request(app).get(`/api/v1${p}`));
const post = (p, token, body = {}) => (token ? auth(request(app).post(`/api/v1${p}`), token) : request(app).post(`/api/v1${p}`)).send(body);

beforeEach(() => {
  jest.resetAllMocks();
  state = freshState();
  binding = undefined;
  groupName = undefined;
  db.withTenantContext.mockImplementation((_orgId, fn) => fn());
  mockQuery.mockImplementation(async (sql, params) => handle(sql, params));
  db.query.mockImplementation(mockQuery);
  const conn = {
    beginTransaction: jest.fn(), query: jest.fn(mockQuery), execute: jest.fn(mockQuery),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  };
  db.getConnection.mockResolvedValue(conn);
  businessEvents.emitTicketCreated.mockResolvedValue(undefined);
  jest.spyOn(messageOutbox, 'enqueue').mockResolvedValue({ queued: true, id: 900 });
  jest.spyOn(privacyNoticeService, 'getNotice').mockResolvedValue({ version: 'v1', content: 'Aviso', hash: 'h'.repeat(64) });
  jest.spyOn(legalDocumentService, 'sign').mockImplementation(async (id) => {
    state.docs[id].status = 'signed';
    return { id, status: 'signed', signed_at: new Date(), title: state.docs[id].title };
  });
});
afterEach(() => jest.restoreAllMocks());

// =============================================================================
describe('Reportar falla', () => {
  test('a fault for a client of the subtree becomes a ticket of the ISP queue', async () => {
    const res = await post('/reseller-app/tickets', asReseller(1), { client_id: 31, subject: 'Sin internet', description: 'No hay señal desde ayer' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ client_id: 31, client_name: 'Ana Ruiz López', subject: 'Sin internet', category: 'technical', status: 'open' });
    expect(state.tickets[0]).toMatchObject({ source: 'reseller', reseller_id: 1, organization_id: ORG });
    expect(state.tickets[0].notes).toMatch(/Tienda Lupita/);
    expect(businessEvents.emitTicketCreated).toHaveBeenCalledWith(ORG, expect.objectContaining({ id: res.body.data.id }));
  });

  test('a client outside the subtree is a 404 and nothing is written', async () => {
    const res = await post('/reseller-app/tickets', asReseller(1), { client_id: 21, subject: 'Sin internet', description: 'No hay señal' });
    expect(res.status).toBe(404);
    expect(state.tickets).toHaveLength(0);
  });

  test('a sub-reseller login reports for its own clients and its parent sees them', async () => {
    expect((await post('/reseller-app/tickets', asReseller(3), { client_id: 31, subject: 'Lento', description: 'Va muy lento' })).status).toBe(201);
    const list = await get('/reseller-app/tickets', asReseller(1));
    expect(list.body.data.map((t) => t.subject)).toEqual(['Lento']);
    // Another reseller sees nothing of it.
    expect((await get('/reseller-app/tickets', asReseller(2))).body.data).toEqual([]);
  });

  test('listing by client: its own client, a 404 for one outside the subtree', async () => {
    expect((await post('/reseller-app/tickets', asReseller(1), { client_id: 31, subject: 'Lento', description: 'Va muy lento' })).status).toBe(201);
    const mine = await get('/reseller-app/tickets?client_id=31', asReseller(1));
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((t) => t.client_id)).toEqual([31]);
    expect((await get('/reseller-app/tickets?client_id=21', asReseller(1))).status).toBe(404);
    expect((await get('/reseller-app/tickets?client_id=abc', asReseller(1))).status).toBe(404);
  });

  test('the daily budget is enforced', async () => {
    for (let i = 0; i < 30; i += 1) state.tickets.push({ id: i + 1, reseller_id: 1, client_id: 31 });
    const res = await post('/reseller-app/tickets', asReseller(1), { client_id: 31, subject: 'Otra', description: 'Otra falla' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_TICKETS');
  });

  test('needs reseller_app.tickets; validation applies', async () => {
    expect((await post('/reseller-app/tickets', asReseller(1, ['reseller_app.use']), { client_id: 31, subject: 'x', description: 'y' })).status).toBe(403);
    expect((await post('/reseller-app/tickets', asReseller(1), { client_id: 31, subject: 'ab', description: 'corto' })).status).toBe(422);
  });
});

// =============================================================================
describe('signing link: staff', () => {
  test('a copy returns the link once; only its hash is stored; it replaces earlier links', async () => {
    const token = asStaff();
    const first = await post('/service-orders/70/signing-links', token, { channel: 'copy' });
    expect(first.status).toBe(201);
    const url = first.body.data.url;
    expect(url).toMatch(/\/firmar\/1-[A-Za-z0-9_-]{43}$/);
    const tok = url.split('/firmar/')[1];
    expect(state.links[0].token_sha256).toBe(sha(tok));
    expect(JSON.stringify(state.links[0])).not.toContain(tok);
    expect(messageOutbox.enqueue).not.toHaveBeenCalled();
    await post('/service-orders/70/signing-links', token, { channel: 'copy' });
    expect(state.links[0].revoked_at).not.toBeNull();
    expect(state.links[1].revoked_at).toBeNull();
  });

  test('email and SMS go through the outbox to the contact on file, as sensitive transactional messages', async () => {
    const token = asStaff();
    const res = await post('/service-orders/70/signing-links', token, { channel: 'sms' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ url: null, link: { channel: 'sms', destination_masked: '*** *** 0001' }, message: { queued: true } });
    const msg = messageOutbox.enqueue.mock.calls[0][0];
    expect(msg).toMatchObject({ channel: 'sms', clientId: 31, recipient: '7225550001', messageClass: 'transactional', sensitive: true, sourceType: 'document_signing_link' });
    expect(msg.bodyText).toMatch(/\/firmar\/1-/);
    expect(state.links[0].message_outbox_id).toBe(900);
  });

  test('refusals: no contact, an order not in process, no document left', async () => {
    const token = asStaff();
    state.clients[31].email = null;
    const noEmail = await post('/service-orders/70/signing-links', token, { channel: 'email' });
    expect([noEmail.status, noEmail.body.error.code]).toEqual([422, 'NO_EMAIL']);
    const notStarted = await post('/service-orders/71/signing-links', token, { channel: 'copy' });
    expect([notStarted.status, notStarted.body.error.code]).toEqual([409, 'ORDER_NOT_SIGNABLE']);
    state.docs[101].status = 'signed';
    state.docs[102].status = 'signed';
    const done = await post('/service-orders/70/signing-links', token, { channel: 'copy' });
    expect([done.status, done.body.error.code]).toEqual([409, 'NO_PENDING_DOCUMENTS']);
    expect(state.links).toHaveLength(0);
  });

  test('a queue failure revokes the link and reports that nothing was sent', async () => {
    messageOutbox.enqueue.mockRejectedValue(new Error('down'));
    const res = await post('/service-orders/70/signing-links', asStaff(), { channel: 'email' });
    expect([res.status, res.body.error.code]).toEqual([502, 'MESSAGE_NOT_QUEUED']);
    expect(state.links[0].revoked_at).not.toBeNull();
  });

  test('lists the links without tokens, and revokes them', async () => {
    const token = asStaff();
    await post('/service-orders/70/signing-links', token, { channel: 'copy' });
    const list = await get('/service-orders/70/signing-links', token);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body.data)).not.toMatch(/token/);
    const revoked = await post('/service-orders/70/signing-links/revoke', token);
    expect(revoked.body.data.revoked).toBe(1);
  });

  test('needs signed_documents.create; a reseller-bound user is fenced', async () => {
    expect((await post('/service-orders/70/signing-links', asStaff(['signed_documents.view']), { channel: 'copy' })).status).toBe(403);
    expect((await post('/service-orders/70/signing-links', asReseller(1, ['signed_documents.create']), { channel: 'copy' })).status).toBe(403);
  });
});

// =============================================================================
describe('signing link: the reseller asks the ISP', () => {
  test('sends to the customer and never returns the link', async () => {
    const res = await post('/reseller-app/leads/5/signing-link', asReseller(1), { channel: 'email' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      link: expect.objectContaining({ channel: 'email', destination_masked: 'a***@example.com' }),
      message: { queued: true, skipped: false, code: null },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/firmar/);
    expect(state.links[0]).toMatchObject({ requested_by: USER, requested_by_reseller_id: 1, channel: 'email' });
  });

  test('cannot copy the link, nor reach a lead outside its subtree', async () => {
    expect((await post('/reseller-app/leads/5/signing-link', asReseller(1), { channel: 'copy' })).status).toBe(422);
    expect((await post('/reseller-app/leads/6/signing-link', asReseller(1), { channel: 'email' })).status).toBe(404);
  });

  test('shows the signing state of its lead', async () => {
    const token = asReseller(1);
    const before = await get('/reseller-app/leads/5/signing', token);
    expect(before.body.data).toMatchObject({ state: 'pending', pending_documents: 2, can_send: true, last_link: null, contacts: { email: true, phone: true } });
    await post('/reseller-app/leads/5/signing-link', token, { channel: 'sms' });
    const after = await get('/reseller-app/leads/5/signing', token);
    expect(after.body.data.last_link).toMatchObject({ channel: 'sms', destination_masked: '*** *** 0001', opened: false });
    expect(JSON.stringify(after.body)).not.toMatch(/token|firmar/);
  });
});

// =============================================================================
describe('public signing page', () => {
  async function staffLink() {
    const res = await post('/service-orders/70/signing-links', asStaff(), { channel: 'copy' });
    binding = undefined;
    return res.body.data.url.split('/firmar/')[1];
  }

  test('shows the documents; the contract waits for the installation visit', async () => {
    const tok = await staffLink();
    const res = await get(`/public/signing/${tok}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ organization_name: 'ISP Ejemplo', customer_first_name: 'Ana' });
    const [auth, contract] = res.body.data.documents;
    expect(auth).toMatchObject({ id: 101, signable: true, waiting_for_visit: false, rendered_body: '# Autorización' });
    expect(contract).toMatchObject({ id: 102, signable: false, waiting_for_visit: true, captures_communication_choices: true });
    expect(res.body.data.privacy_notice).toMatchObject({ version: 'v1' });
    expect(JSON.stringify(res.body)).not.toMatch(/ana@example|7225550001/);
    state.workOrders[90].status = 'in_progress';
    const later = await get(`/public/signing/${tok}`);
    expect(later.body.data.documents[1]).toMatchObject({ signable: true, waiting_for_visit: false });
  });

  test('the customer signs through the link: self-service capture, the link recorded, then it ends', async () => {
    const tok = await staffLink();
    const body = { signer_name: 'Ana Ruiz', signature_image: 'data:image/png;base64,AAAA', accept: true };
    const first = await post(`/public/signing/${tok}/documents/101/sign`, null, body);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ document: { id: 101, status: 'signed' }, remaining: 1 });
    expect(legalDocumentService.sign).toHaveBeenCalledWith(101, expect.objectContaining({
      orgId: ORG, performedBy: null, signerName: 'Ana Ruiz', signingLinkId: state.links[0].id,
    }));
    await post(`/public/signing/${tok}/documents/102/sign`, null, { ...body, communication_opt_ins: { email: true, sms: false, whatsapp: false }, communication_choices_confirmed: true, privacy_notice_version: 'v1', privacy_notice_hash: 'h'.repeat(64) });
    expect(state.links[0].completed_at).not.toBeNull();
    const after = await get(`/public/signing/${tok}`);
    expect([after.status, after.body.error.code]).toEqual([410, 'LINK_COMPLETED']);
  });

  test('refusals: no acceptance, a document of another order, a bad, expired or replaced token', async () => {
    const tok = await staffLink();
    const body = { signer_name: 'Ana Ruiz', signature_image: 'data:image/png;base64,AAAA', accept: false };
    expect((await post(`/public/signing/${tok}/documents/101/sign`, null, body)).body.error.code).toBe('ACCEPT_REQUIRED');
    expect((await post(`/public/signing/${tok}/documents/201/sign`, null, { ...body, accept: true })).status).toBe(404);
    expect(legalDocumentService.sign).not.toHaveBeenCalled();
    expect((await get('/public/signing/not-a-token')).status).toBe(404);
    expect((await get(`/public/signing/1-${'A'.repeat(43)}`)).status).toBe(404);
    state.links[0].expires_at = new Date(Date.now() - 1000);
    expect((await get(`/public/signing/${tok}`)).body.error.code).toBe('LINK_EXPIRED');
    state.links[0].expires_at = new Date(Date.now() + 3600 * 1000);
    await post('/service-orders/70/signing-links', asStaff(), { channel: 'copy' });
    expect((await get(`/public/signing/${tok}`)).body.error.code).toBe('LINK_REVOKED');
  });

  test('the token picks the tenant database of the organization it names', async () => {
    const tok = await staffLink();
    db.withTenantContext.mockClear();
    await get(`/public/signing/${tok}`);
    expect(db.withTenantContext).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(links.tokenOrg(tok)).toBe(ORG);
    expect(links.tokenOrg('12-short')).toBeNull();
  });
});

// =============================================================================
describe('the signing page leaks no token', () => {
  test('/firmar sends no Referer, is never cached or indexed', async () => {
    const res = await request(app).get(`/firmar/1-${'A'.repeat(43)}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
  });

  test('the proxy access log masks the token in the request line and the referer', () => {
    const conf = fs.readFileSync(path.join(__dirname, '..', 'nginx', 'nginx.conf'), 'utf8');
    expect(conf).toMatch(/map \$request \$vigabss_log_request/);
    expect(conf).toMatch(/map \$http_referer \$vigabss_log_referer/);
    const format = conf.slice(conf.indexOf('log_format main'), conf.indexOf(';', conf.indexOf('log_format main')));
    expect(format).toContain('$vigabss_log_request');
    expect(format).toContain('$vigabss_log_referer');
    expect(format).not.toMatch(/"\$request"|\$http_referer/);
  });
});

// =============================================================================
describe('migration 009', () => {
  const file = path.join(__dirname, '..', 'database', 'migrations', '009_reseller_tickets_signing_links.sql');
  const sql = fs.readFileSync(file, 'utf8');

  // Not "the latest": tests/sqlColumnCheck.test.js drops throwaway migrations
  // into the directory while it runs, so a parallel "latest" check is flaky.
  test('exists, with a rollback of the same name', () => {
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '..', 'database', 'rollbacks', '009_reseller_tickets_signing_links.sql'))).toBe(true);
  });

  test('every ALTER is guarded and the token is stored only hashed', () => {
    const alters = sql.match(/ALTER TABLE [^;]+;/g) || [];
    expect(alters.length).toBeGreaterThanOrEqual(7);
    for (const proc of ['m009_reseller_tickets', 'm009_signed_documents_link']) {
      expect(sql).toMatch(new RegExp(`DROP PROCEDURE IF EXISTS ${proc};`));
    }
    expect(sql).toMatch(/token_sha256\s+CHAR\(64\)/);
    expect(sql).not.toMatch(/\btoken\s+VARCHAR/i);
  });

  test('schema.sql carries the signing links table and the new columns', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS document_signing_links/);
    expect(schema).toMatch(/signing_link_id\s+BIGINT UNSIGNED NULL/);
    expect(schema).toMatch(/'automation','reseller'\) NOT NULL DEFAULT 'manual'/);
    expect(schema).toMatch(/reseller_id\s+BIGINT UNSIGNED NULL\s+COMMENT 'Reseller whose user reported it/);
  });
});
