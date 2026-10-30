// =============================================================================
// VigaBSS 5.0 — Organization binding beyond client_id: portal service requests,
// Web Push, WhatsApp links/bot, and staff bandwidth-test routes
// =============================================================================
// A client_id match alone is not a tenant boundary (ARCHITECTURE.md): another
// organization can hold rows naming this subscriber's client_id. These tests
// drive the real routers/services against a small SQL-aware fake whose WHERE
// evaluator applies only the predicates a statement actually binds, so an
// unscoped statement genuinely sees (and mutates) the foreign row. The staff
// half covers body references (contract_id, test_server_id, site_id → 422)
// and path ids (→ 404) on the bandwidth-test routes.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const wa = require('../src/services/whatsappService');
const bot = require('../src/services/whatsappBotService');
const app = require('../src/app');

const ORG_A = 1; // the subscriber's / staff user's organization
const ORG_B = 2; // another tenant holding rows that name the same client_id

const OWN_PHONE = '+525500000001';

function freshTables() {
  return {
    users: [
      { id: 50, email: 'admin@a.example', role: 'admin', status: 'active', organization_id: ORG_A },
    ],
    clients: [
      // Client 10 has NO contract of its own; client 30 has one (31).
      { id: 10, organization_id: ORG_A, name: 'Alice (A)', email: 'alice@a.example', status: 'active', deleted_at: null },
      { id: 30, organization_id: ORG_A, name: 'Carol (A)', email: 'carol@a.example', status: 'active', deleted_at: null },
    ],
    contracts: [
      { id: 21, organization_id: ORG_B, client_id: 10, plan_id: 92, plan_name: 'FOREIGN-PLAN', price: '900.00', status: 'active', deleted_at: null },
      { id: 31, organization_id: ORG_A, client_id: 30, plan_id: 90, plan_name: 'Own Plan', price: '300.00', status: 'active', deleted_at: null },
    ],
    plans: [
      { id: 90, organization_id: ORG_A, name: 'Own Plan', price: '300.00', deleted_at: null },
      { id: 91, organization_id: ORG_A, name: 'Own Upgrade', price: '400.00', deleted_at: null },
      { id: 92, organization_id: ORG_B, name: 'FOREIGN-PLAN', price: '900.00', deleted_at: null },
    ],
    billing_periods: [],
    invoices: [
      { id: 951, organization_id: ORG_B, client_id: 10, invoice_number: 'ORG-B-INV', total: '999.00', status: 'issued', deleted_at: null },
    ],
    portal_service_requests: [
      { id: 801, organization_id: ORG_A, client_id: 10, request_type: 'visit_schedule', status: 'pending', deleted_at: null },
      { id: 802, organization_id: ORG_B, client_id: 10, request_type: 'cancellation', status: 'pending', deleted_at: null },
    ],
    portal_push_subscriptions: [
      { id: 851, organization_id: ORG_B, client_id: 10, endpoint: 'https://push.example/foreign', p256dh: 'b', auth: 'b', deleted_at: null },
      { id: 852, organization_id: ORG_A, client_id: 10, endpoint: 'https://push.example/own', p256dh: 'a', auth: 'a', deleted_at: null },
    ],
    whatsapp_links: [
      { id: 701, organization_id: ORG_A, client_id: 10, phone_e164: OWN_PHONE, active_phone: OWN_PHONE, bound_via: 'portal', status: 'active' },
      { id: 702, organization_id: ORG_B, client_id: 10, phone_e164: '+525500000002', active_phone: '+525500000002', bound_via: 'staff', status: 'active' },
    ],
    // Foreign-org codes that name client 10: enough to exhaust either budget
    // if they were (wrongly) counted against the subscriber.
    whatsapp_verifications: Array.from({ length: 5 }, (_v, k) => ([
      { id: 1100 + k, organization_id: ORG_B, client_id: 10, purpose: 'link_portal', consumed_at: null },
      { id: 1200 + k, organization_id: ORG_B, client_id: 10, purpose: 'link_email', consumed_at: null },
    ])).flat(),
    whatsapp_conversation_state: [
      { phone_e164: OWN_PHONE, client_id: 10, state: 'await_problem_desc', context: null },
    ],
    whatsapp_inbound_messages: [],
    sites: [
      { id: 61, organization_id: ORG_A, name: 'Own POP', deleted_at: null },
      { id: 62, organization_id: ORG_B, name: 'Foreign POP', deleted_at: null },
    ],
    bandwidth_test_servers: [
      { id: 71, organization_id: ORG_A, name: 'own-iperf', host: '10.1.0.9', deleted_at: null },
      { id: 72, organization_id: ORG_B, name: 'FOREIGN-SERVER', host: '10.2.0.9', auth_token: 'org-b-secret', deleted_at: null },
      { id: 73, organization_id: null, name: 'global-iperf', host: '10.0.0.9', deleted_at: null },
      { id: 74, organization_id: ORG_B, name: 'FOREIGN-DELETED', host: '10.2.0.8', deleted_at: '2026-10-01 00:00:00' },
    ],
    subscriber_speed_test_jobs: [
      { id: 401, organization_id: ORG_A, contract_id: 31, status: 'queued', requested_by: 'admin' },
      { id: 402, organization_id: ORG_B, contract_id: 21, status: 'queued', requested_by: 'admin', notes: 'ORG-B-JOB' },
    ],
    tickets: [],
  };
}

let T;
let writes;
let nextId;
let granted;

const norm = v => (v === null || v === undefined ? null : String(v));

function matchWhere(rows, rawSql, params) {
  // `(organization_id <=> ? OR organization_id IS NULL)` — "own or global" — is
  // an OR this evaluator cannot otherwise express; give it a dedicated op.
  const sql = rawSql.replace(
    /\((?:\w+\.)?organization_id\s*<=>\s*\?\s+OR\s+(?:\w+\.)?organization_id\s+IS\s+NULL\)/gi,
    'organization_id ~own ?',
  );
  const at = sql.search(/\bWHERE\b/i);
  if (at < 0) return rows;
  let i = (sql.slice(0, at).match(/\?/g) || []).length;
  const where = sql.slice(at + 5).split(/\b(?:ORDER BY|LIMIT|GROUP BY|FOR UPDATE)\b/i)[0];
  const preds = [];
  const re = /(?:\w+\.)?`?(\w+)`?\s*(<=>|=|~own)\s*\?|(?:\w+\.)?`?(\w+)`?\s+IS\s+(NOT\s+)?NULL/gi;
  let m;
  while ((m = re.exec(where))) {
    if (m[1]) preds.push({ col: m[1], op: m[2], val: params[i++] });
    else preds.push({ col: m[3], op: m[4] ? 'notnull' : 'null' });
  }
  return rows.filter(row => preds.every(({ col, op, val }) => {
    if (op === 'null') return row[col] === null || row[col] === undefined;
    if (op === 'notnull') return row[col] !== null && row[col] !== undefined;
    if (op === '=' && (val === null || val === undefined)) return false;
    if (op === '~own') return norm(row[col]) === null || norm(row[col]) === norm(val);
    return norm(row[col]) === norm(val);
  }));
}

function tableOf(sql) {
  const m = sql.match(/^\s*(?:SELECT[\s\S]*?\bFROM|UPDATE|DELETE\s+FROM|INSERT\s+(?:IGNORE\s+)?INTO)\s+`?(\w+)`?/i);
  return m ? m[1] : null;
}

function fakeQuery(sql, params = []) {
  if (/FROM `?users`?\b/.test(sql)) return [T.users];
  if (/MIN\(due_date\) AS next_due/.test(sql)) return [[{ next_due: null }]];

  // Conversation state has no organization_id: the scoped delete joins the
  // parent client on its org. Emulate exactly that join.
  const joined = sql.match(/^\s*DELETE\s+s\s+FROM\s+whatsapp_conversation_state\s+s\s+JOIN\s+clients\s+c\s+ON\s+c\.id\s*=\s*s\.client_id\s+AND\s+c\.organization_id\s*<=>\s*\?\s+WHERE\s+s\.client_id\s*=\s*\?/i);
  if (joined) {
    writes.push({ sql, params });
    const [orgId, clientId] = params;
    const before = T.whatsapp_conversation_state.length;
    T.whatsapp_conversation_state = T.whatsapp_conversation_state.filter((s) => {
      const parent = T.clients.find(c => norm(c.id) === norm(s.client_id));
      return !(norm(s.client_id) === norm(clientId) && parent && norm(parent.organization_id) === norm(orgId));
    });
    return [{ affectedRows: before - T.whatsapp_conversation_state.length }];
  }

  const table = tableOf(sql);

  if (/^\s*INSERT/i.test(sql)) {
    writes.push({ sql, params });
    const cols = (sql.match(/\(([^)]*)\)\s*VALUES/i) || [])[1];
    const vals = (sql.match(/VALUES\s*\(([\s\S]*)\)\s*$/i) || [])[1];
    const row = { id: nextId++, deleted_at: null };
    if (cols && vals) {
      let p = 0;
      const vs = vals.split(',').map(v => v.trim());
      cols.split(',').map(c => c.trim().replace(/`/g, '')).forEach((c, k) => {
        row[c] = vs[k] === '?' ? params[p++] : vs[k].replace(/^'|'$/g, '');
      });
    }
    if (T[table]) T[table].push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }

  if (/^\s*DELETE/i.test(sql)) {
    writes.push({ sql, params });
    const hit = matchWhere(T[table] || [], sql, params);
    T[table] = (T[table] || []).filter(r => !hit.includes(r));
    return [{ affectedRows: hit.length }];
  }

  if (/^\s*UPDATE/i.test(sql)) {
    writes.push({ sql, params });
    const hit = matchWhere(T[table] || [], sql, params);
    const literalStatus = sql.match(/SET status = '(\w+)'/);
    if (literalStatus) hit.forEach(r => { r.status = literalStatus[1]; });
    if (/SET deleted_at = NOW\(\)/.test(sql)) hit.forEach(r => { r.deleted_at = 'now'; });
    if (/SET deleted_at = NULL/.test(sql)) hit.forEach(r => { r.deleted_at = null; });
    return [{ affectedRows: hit.length }];
  }

  const rows = matchWhere(T[table] || [], sql, params);
  if (/COUNT\(\*\)\s+AS\s+total/i.test(sql)) return [[{ total: rows.length }]];
  if (/COUNT\(\*\)\s+AS\s+n\b/i.test(sql)) return [[{ n: rows.length }]];
  return [rows];
}

const writesTo = table => writes.filter(({ sql }) =>
  new RegExp(`^\\s*(INSERT INTO|UPDATE|DELETE\\s+(?:s\\s+)?FROM)\\s+\`?${table}\`?\\b`, 'i').test(sql));
const row = (table, id) => T[table].find(r => r.id === id);

beforeEach(() => {
  jest.clearAllMocks();
  T = freshTables();
  writes = [];
  nextId = 9000;
  granted = [];
  db.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const portal = (method, path, clientId = 10) =>
  request(app)[method](path)
    .set('Authorization', `Bearer ${signPortalAccessToken({ clientId }, 900)}`);

const staffToken = orgId => jwt.sign(
  { sub: 50, email: 'admin@a.example', role: 'admin', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);
const staff = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${staffToken(ORG_A)}`);

// ---------------------------------------------------------------------------
// Portal self-service requests (portalServiceRequestService)
// ---------------------------------------------------------------------------

describe('portal service requests are bound to the subscriber\'s organization', () => {
  test('a foreign-org request naming this client_id is neither listed nor counted', async () => {
    const res = await portal('get', '/api/v1/portal/service-requests');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.id)).toEqual([801]);
    expect(res.body.meta.total).toBe(1);
  });

  test('a foreign-org request cannot be cancelled (404, row untouched)', async () => {
    const res = await portal('post', '/api/v1/portal/service-requests/802/cancel');
    expect(res.status).toBe(404);
    expect(row('portal_service_requests', 802).status).toBe('pending');
    expect(writesTo('portal_service_requests')).toEqual([]);
  });

  test('cancelling an own request writes with client and org bound', async () => {
    const res = await portal('post', '/api/v1/portal/service-requests/801/cancel');
    expect(res.status).toBe(200);
    expect(row('portal_service_requests', 801).status).toBe('cancelled');
    const [upd] = writesTo('portal_service_requests');
    expect(upd.sql).toMatch(/organization_id <=> \?/);
    expect(upd.params).toEqual(['801', 10, ORG_A]);
  });

  test('a new request lands in the client\'s org and never attaches another org\'s contract', async () => {
    const res = await portal('post', '/api/v1/portal/service-requests')
      .send({ request_type: 'visit_schedule', payload: { preferred_date: '2026-11-02' } });
    expect(res.status).toBe(201);
    const [insert] = writesTo('portal_service_requests');
    expect(insert.params[0]).toBe(ORG_A); // organization_id
    expect(insert.params[1]).toBe(10); // client_id
    expect(insert.params[2]).toBeNull(); // contract_id — foreign contract 21 ignored
  });

  test('plan_upgrade cannot target another org\'s plan (404, no insert)', async () => {
    const res = await portal('post', '/api/v1/portal/service-requests', 30)
      .send({ request_type: 'plan_upgrade', payload: { new_plan_id: 92 } });
    expect(res.status).toBe(404);
    expect(writesTo('portal_service_requests')).toEqual([]);
  });

  test('plan_upgrade to an own-org plan is filed in the client\'s org', async () => {
    const res = await portal('post', '/api/v1/portal/service-requests', 30)
      .send({ request_type: 'plan_upgrade', payload: { new_plan_id: 91 } });
    expect(res.status).toBe(201);
    const [insert] = writesTo('portal_service_requests');
    expect(insert.params.slice(0, 3)).toEqual([ORG_A, 30, 31]);
  });
});

// ---------------------------------------------------------------------------
// Web Push subscriptions
// ---------------------------------------------------------------------------

describe('portal Web Push subscriptions are bound to the subscriber\'s organization', () => {
  test('subscribing does not update another org\'s row for the same endpoint; it inserts in the client\'s org', async () => {
    const res = await portal('post', '/api/v1/portal/push/subscribe')
      .send({ endpoint: 'https://push.example/foreign', p256dh: 'new-key', auth: 'new-auth' });
    expect(res.status).toBe(201);
    expect(res.body.data.updated).toBe(false);
    expect(row('portal_push_subscriptions', 851).p256dh).toBe('b');
    const pushWrites = writesTo('portal_push_subscriptions');
    expect(pushWrites).toHaveLength(1);
    expect(pushWrites[0].sql).toMatch(/^\s*INSERT/i);
    expect(pushWrites[0].params.slice(0, 2)).toEqual([ORG_A, 10]);
  });

  test('unsubscribing never soft-deletes another org\'s row', async () => {
    const res = await portal('delete', '/api/v1/portal/push/subscribe')
      .send({ endpoint: 'https://push.example/foreign' });
    expect(res.status).toBe(200);
    expect(row('portal_push_subscriptions', 851).deleted_at).toBeNull();
  });

  test('unsubscribing an own endpoint soft-deletes it', async () => {
    const res = await portal('delete', '/api/v1/portal/push/subscribe')
      .send({ endpoint: 'https://push.example/own' });
    expect(res.status).toBe(200);
    expect(row('portal_push_subscriptions', 852).deleted_at).toBe('now');
  });
});

// ---------------------------------------------------------------------------
// WhatsApp links (portal) and the inbound bot (webhook-derived org)
// ---------------------------------------------------------------------------

describe('portal WhatsApp linking is bound to the subscriber\'s organization', () => {
  test('status lists only own-org links', async () => {
    const res = await portal('get', '/api/v1/portal/whatsapp/status');
    expect(res.status).toBe(200);
    expect(res.body.data.links.map(l => l.id)).toEqual([701]);
  });

  test('a foreign-org link cannot be revoked (404) and its conversation state survives', async () => {
    const res = await portal('delete', '/api/v1/portal/whatsapp/link/702');
    expect(res.status).toBe(404);
    expect(row('whatsapp_links', 702).status).toBe('active');
    expect(T.whatsapp_conversation_state).toHaveLength(1);
  });

  test('revoking an own link binds the org and clears state through the parent client', async () => {
    const res = await portal('delete', '/api/v1/portal/whatsapp/link/701');
    expect(res.status).toBe(200);
    expect(row('whatsapp_links', 701).status).toBe('revoked');
    expect(row('whatsapp_links', 702).status).toBe('active');
    expect(T.whatsapp_conversation_state).toHaveLength(0);
    const [revoke] = writesTo('whatsapp_links');
    expect(revoke.params).toEqual([701, 10, ORG_A]);
  });

  test('another org\'s pending codes do not exhaust this client\'s link-code budget; the new code lands in the client\'s org', async () => {
    const res = await portal('post', '/api/v1/portal/whatsapp/link-code');
    expect(res.status).toBe(200);
    const [insert] = writesTo('whatsapp_verifications');
    expect(insert.params[0]).toBe(ORG_A);
    expect(insert.params[3]).toBe(10);
  });

  test('another org\'s email codes do not count against this client\'s email budget', async () => {
    await expect(wa.clientEmailCodeBudgetExceeded(10, ORG_A)).resolves.toBe(false);
    await expect(wa.clientEmailCodeBudgetExceeded(10, ORG_B)).resolves.toBe(true);
  });
});

describe('WhatsApp bot answers from the bound link\'s organization only', () => {
  // No in-flight flow: the message is parsed as a fresh menu intent.
  beforeEach(() => { T.whatsapp_conversation_state = []; });

  test('plan reply ignores another org\'s contract naming this client_id', async () => {
    const { reply } = await bot.handleInbound({ phone: OWN_PHONE, body: 'plan' });
    expect(reply).not.toContain('FOREIGN-PLAN');
    expect(reply).toMatch(/don't have an active service/i);
  });

  test('invoice reply ignores another org\'s invoice naming this client_id', async () => {
    const { reply } = await bot.handleInbound({ phone: OWN_PHONE, body: 'factura' });
    expect(reply).not.toContain('ORG-B-INV');
    expect(reply).toMatch(/no invoices/i);
  });

  test('UNLINK revokes with the link\'s own org bound', async () => {
    await bot.handleInbound({ phone: OWN_PHONE, body: 'UNLINK' });
    expect(row('whatsapp_links', 701).status).toBe('revoked');
    expect(row('whatsapp_links', 702).status).toBe('active');
    const [revoke] = writesTo('whatsapp_links').filter(w => /status = 'revoked'/.test(w.sql));
    expect(revoke.params).toEqual([701, 10, ORG_A]);
  });
});

// ---------------------------------------------------------------------------
// Staff bandwidth-test routes
// ---------------------------------------------------------------------------

describe('POST /subscriber-speed-test-jobs verifies body references in req.orgId', () => {
  beforeEach(() => { granted = ['subscriber_speed_tests.create']; });

  test('a foreign contract_id is 422 and nothing is inserted', async () => {
    const res = await staff('post', '/api/v1/subscriber-speed-test-jobs').send({ contract_id: 21 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(writesTo('subscriber_speed_test_jobs')).toEqual([]);
  });

  test('a foreign test_server_id is 422 and nothing is inserted', async () => {
    const res = await staff('post', '/api/v1/subscriber-speed-test-jobs').send({ contract_id: 31, test_server_id: 72 });
    expect(res.status).toBe(422);
    expect(writesTo('subscriber_speed_test_jobs')).toEqual([]);
  });

  test('an own contract with a global test server is accepted in req.orgId', async () => {
    const res = await staff('post', '/api/v1/subscriber-speed-test-jobs').send({ contract_id: 31, test_server_id: 73 });
    expect(res.status).toBe(201);
    const [insert] = writesTo('subscriber_speed_test_jobs');
    expect(insert.params.slice(0, 3)).toEqual([ORG_A, 31, 73]);
  });
});

describe('speed-test job path ids outside req.orgId are 404', () => {
  test('cancelling a foreign job is 404, leaves it queued and does not leak it', async () => {
    granted = ['subscriber_speed_tests.update'];
    const res = await staff('post', '/api/v1/subscriber-speed-test-jobs/402/cancel');
    expect(res.status).toBe(404);
    expect(row('subscriber_speed_test_jobs', 402).status).toBe('queued');
    expect(JSON.stringify(res.body)).not.toContain('ORG-B-JOB');
  });

  test('a foreign job is 404 on GET', async () => {
    granted = ['subscriber_speed_tests.view'];
    const res = await staff('get', '/api/v1/subscriber-speed-test-jobs/402');
    expect(res.status).toBe(404);
  });
});

describe('bandwidth test servers: foreign path ids are 404, foreign site_id is 422', () => {
  test('PUT on a foreign server is 404, writes nothing and does not leak it', async () => {
    granted = ['bandwidth_test_servers.update'];
    const res = await staff('put', '/api/v1/bandwidth-test-servers/72').send({ name: 'hijack' });
    expect(res.status).toBe(404);
    expect(writesTo('bandwidth_test_servers')).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/FOREIGN-SERVER|org-b-secret/);
  });

  test('restore of a foreign server is 404, writes nothing and does not leak it', async () => {
    granted = ['bandwidth_test_servers.update'];
    const res = await staff('post', '/api/v1/bandwidth-test-servers/74/restore');
    expect(res.status).toBe(404);
    expect(row('bandwidth_test_servers', 74).deleted_at).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('FOREIGN-DELETED');
  });

  test('DELETE of a foreign server is 404 and it stays live', async () => {
    granted = ['bandwidth_test_servers.delete'];
    const res = await staff('delete', '/api/v1/bandwidth-test-servers/72');
    expect(res.status).toBe(404);
    expect(row('bandwidth_test_servers', 72).deleted_at).toBeNull();
  });

  test('DELETE of an own server is 204', async () => {
    granted = ['bandwidth_test_servers.delete'];
    const res = await staff('delete', '/api/v1/bandwidth-test-servers/71');
    expect(res.status).toBe(204);
    expect(row('bandwidth_test_servers', 71).deleted_at).toBe('now');
  });

  test('POST with a foreign site_id is 422 and nothing is inserted', async () => {
    granted = ['bandwidth_test_servers.create'];
    const res = await staff('post', '/api/v1/bandwidth-test-servers')
      .send({ name: 'new', host: '10.1.0.10', site_id: 62 });
    expect(res.status).toBe(422);
    expect(writesTo('bandwidth_test_servers')).toEqual([]);
  });

  test('PUT on an own server with a foreign site_id is 422 and writes nothing', async () => {
    granted = ['bandwidth_test_servers.update'];
    const res = await staff('put', '/api/v1/bandwidth-test-servers/71').send({ site_id: 62 });
    expect(res.status).toBe(422);
    expect(writesTo('bandwidth_test_servers')).toEqual([]);
  });

  test('PUT on an own server with an own site_id succeeds', async () => {
    granted = ['bandwidth_test_servers.update'];
    const res = await staff('put', '/api/v1/bandwidth-test-servers/71').send({ site_id: 61 });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(71);
    const [upd] = writesTo('bandwidth_test_servers');
    expect(upd.params.slice(-2)).toEqual(['71', ORG_A]);
  });
});
