// =============================================================================
// VigaBSS 5.0 — Subscriber portal: organization binding beyond client_id
// =============================================================================
// A client_id match alone is not a tenant boundary (ARCHITECTURE.md): on a
// shared database another organization can hold rows naming this subscriber's
// client_id (planted through an old FK hole, an import, or a bug). Every portal
// query on a tenant table must therefore also bind req.client.organizationId,
// null-safe. These tests drive the real portal router against a small
// SQL-aware fake whose WHERE evaluator applies only the predicates a statement
// actually binds, so an unscoped statement genuinely sees the foreign row.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/services/aiReplyService', () => ({ generate: jest.fn() }));
jest.mock('../src/services/clientBalanceService', () => ({
  computeClientBalance: jest.fn().mockResolvedValue({ balance: 0, currency: 'MXN' }),
}));
jest.mock('../src/services/privacyNoticeService', () => ({
  getNotice: jest.fn().mockResolvedValue({ version: 'v1', content: 'Aviso', hash: 'h1' }),
}));
jest.mock('../src/services/dataPackService', () => ({
  listPacks: jest.fn().mockResolvedValue([]),
  purchasePack: jest.fn().mockResolvedValue({ id: 1 }),
  listPurchases: jest.fn().mockResolvedValue([]),
  getEffectiveAllowance: jest.fn().mockResolvedValue({ total_gb: 999 }),
}));

const request = require('supertest');
const db = require('../src/config/database');
const aiReplyService = require('../src/services/aiReplyService');
const dataPackService = require('../src/services/dataPackService');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const ORG_A = 1; // the subscriber's organization
const ORG_B = 2; // another tenant holding rows that name the subscriber's client_id

// Client 10 has NO contract of its own; client 30 has one (31).
const tokenFor = clientId => signPortalAccessToken({ clientId }, 900);

function freshTables() {
  return {
    clients: [
      { id: 10, organization_id: ORG_A, name: 'Alice (A)', email: 'alice@a.example', status: 'active', deleted_at: null },
      { id: 30, organization_id: ORG_A, name: 'Carol (A)', email: 'carol@a.example', status: 'active', deleted_at: null },
    ],
    contracts: [
      { id: 21, organization_id: ORG_B, client_id: 10, status: 'active', deleted_at: null },
      { id: 31, organization_id: ORG_A, client_id: 30, status: 'active', deleted_at: null },
    ],
    payments: [
      { id: 101, organization_id: ORG_A, client_id: 10, amount: '100.00', reference_number: 'OWN-PAY', status: 'completed', deleted_at: null },
      { id: 202, organization_id: ORG_B, client_id: 10, amount: '999.00', reference_number: 'ORG-B-PAY', status: 'completed', deleted_at: null },
    ],
    recurring_payment_profiles: [
      { id: 301, organization_id: ORG_B, client_id: 10, card_brand: 'visa', card_last_four: '4242', status: 'active', is_default: 1 },
    ],
    subscriber_speed_test_jobs: [
      { id: 401, organization_id: ORG_A, contract_id: 31, status: 'completed', requested_by: 'client_portal' },
      { id: 402, organization_id: ORG_B, contract_id: 31, status: 'completed', requested_by: 'admin' },
    ],
    portal_chat_sessions: [
      { id: 501, organization_id: ORG_A, client_id: 10, session_token: 'tok-own', messages: '[]', status: 'active', turn_count: 0, ticket_id: null },
      { id: 502, organization_id: ORG_B, client_id: 10, session_token: 'tok-foreign', messages: '[]', status: 'active', turn_count: 0, ticket_id: null },
    ],
    subscriber_consents: [
      { id: 601, organization_id: ORG_B, client_id: 10, consent_version: 'v1', purpose: 'service_delivery', document_hash: 'h1', withdrawn_at: null, given_at: '2026-10-01 00:00:00' },
    ],
    tickets: [],
    bandwidth_test_servers: [],
    invoices: [],
  };
}

let T;
let writes;
let nextId;

const same = (a, b) => (a === null || a === undefined ? null : String(a))
  === (b === null || b === undefined ? null : String(b));

function matchWhere(rows, sql, params) {
  const at = sql.search(/\bWHERE\b/i);
  if (at < 0) return rows;
  let i = (sql.slice(0, at).match(/\?/g) || []).length;
  const where = sql.slice(at + 5).split(/\b(?:ORDER BY|LIMIT|GROUP BY|FOR UPDATE)\b/i)[0];
  const preds = [];
  const re = /(?:\w+\.)?`?(\w+)`?\s*(<=>|=)\s*\?|(?:\w+\.)?`?(\w+)`?\s+IS\s+(NOT\s+)?NULL/gi;
  let m;
  while ((m = re.exec(where))) {
    if (m[1]) preds.push({ col: m[1], op: m[2], val: params[i++] });
    else preds.push({ col: m[3], op: m[4] ? 'notnull' : 'null' });
  }
  return rows.filter(row => preds.every(({ col, op, val }) => {
    if (op === 'null') return row[col] === null || row[col] === undefined;
    if (op === 'notnull') return row[col] !== null && row[col] !== undefined;
    if (op === '=' && (val === null || val === undefined)) return false;
    return same(row[col], val);
  }));
}

function tableOf(sql) {
  const m = sql.match(/^\s*(?:SELECT[\s\S]*?\bFROM|UPDATE|DELETE\s+FROM|INSERT\s+(?:IGNORE\s+)?INTO)\s+`?(\w+)`?/i);
  return m ? m[1] : null;
}

function fakeQuery(rawSql, params = []) {
  // The consent lookup's `(document_hash IS NULL OR document_hash = ?)` is an
  // OR this evaluator cannot express; every fixture row carries a hash.
  const sql = rawSql.replace(/\(document_hash IS NULL OR document_hash = \?\)/, 'document_hash = ?');
  const table = tableOf(sql);

  if (/MIN\(due_date\) AS next_due/.test(sql)) return [[{ next_due: null }]];

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

  if (/^\s*(UPDATE|DELETE)/i.test(sql)) {
    writes.push({ sql, params });
    const hit = matchWhere(T[table] || [], sql, params);
    const literalStatus = sql.match(/SET status = '(\w+)'/);
    if (literalStatus) hit.forEach(r => { r.status = literalStatus[1]; });
    return [{ affectedRows: hit.length }];
  }

  const rows = matchWhere(T[table] || [], sql, params);
  if (/COUNT\(\*\)\s+AS\s+total/i.test(sql)) return [[{ total: rows.length }]];
  return [rows];
}

const writesTo = table => writes.filter(({ sql }) => new RegExp(`^\\s*(INSERT INTO|UPDATE)\\s+\`?${table}\`?\\b`, 'i').test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  T = freshTables();
  writes = [];
  nextId = 9000;
  db.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

const portal = (method, path, clientId = 10) =>
  request(app)[method](path).set('Authorization', `Bearer ${tokenFor(clientId)}`);

describe('GET /portal/payments is bound to the subscriber\'s organization', () => {
  test('a foreign-org payment naming this client_id is neither listed nor counted', async () => {
    const res = await portal('get', '/api/v1/portal/payments');
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.id)).toEqual([101]);
    expect(res.body.meta.total).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B-PAY');
  });
});

describe('AI chat binds the session and its tickets to the subscriber\'s organization', () => {
  test('another org\'s chat session naming this client_id is 404 and creates no ticket', async () => {
    aiReplyService.generate.mockResolvedValue({ action: 'escalate', draftText: 'escalating' });
    const res = await portal('post', '/api/v1/portal/chat/tok-foreign/message').send({ message: 'help' });
    expect(res.status).toBe(404);
    expect(writesTo('tickets')).toEqual([]);
    expect(writesTo('portal_chat_sessions')).toEqual([]);
    expect(aiReplyService.generate).not.toHaveBeenCalled();
  });

  test('an escalated chat ticket lands in the client\'s org', async () => {
    aiReplyService.generate.mockResolvedValue({ action: 'escalate', draftText: 'escalating' });
    const res = await portal('post', '/api/v1/portal/chat/tok-own/message').send({ message: 'help' });
    expect(res.status).toBe(200);
    expect(res.body.data.session_status).toBe('escalated');
    const [insert] = writesTo('tickets');
    expect(insert.params[0]).toBe(ORG_A);
    expect(insert.params[1]).toBe(10);
    expect(T.tickets).toHaveLength(1);
    expect(T.tickets[0]).toMatchObject({ organization_id: ORG_A, client_id: 10, status: 'open' });
    expect(res.body.data.ticket_id).toBe(T.tickets[0].id);
    expect(aiReplyService.generate).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
  });

  // The session's ticket is no longer closed after each reply (ASY-09); an
  // auto-sent answer moves it to 'waiting'. That write, like the session
  // save, is bound to the client and organization.
  test('updating the session ticket and saving the session bind client and org', async () => {
    aiReplyService.generate.mockResolvedValue({ action: 'auto_sent', draftText: 'answer' });
    const res = await portal('post', '/api/v1/portal/chat/tok-own/message').send({ message: 'hi' });
    expect(res.status).toBe(200);
    const update = writesTo('tickets').find(w => /^\s*UPDATE/i.test(w.sql));
    expect(update.sql).toMatch(/SET status = 'waiting'/);
    expect(update.sql).toMatch(/organization_id <=> \?/);
    expect(update.params.slice(1, 3)).toEqual([10, ORG_A]);
    const save = writesTo('portal_chat_sessions')[0];
    expect(save.sql).toMatch(/organization_id <=> \?/);
    expect(save.params.slice(-3)).toEqual([501, 10, ORG_A]);
  });
});

describe('active-contract lookups ignore another org\'s contract naming this client_id', () => {
  test('dashboard shows no contract', async () => {
    const res = await portal('get', '/api/v1/portal/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.contract).toBeNull();
  });

  test('speed test cannot be queued against the foreign contract', async () => {
    const res = await portal('post', '/api/v1/portal/speed-test');
    expect(res.status).toBe(422);
    expect(writesTo('subscriber_speed_test_jobs')).toEqual([]);
  });

  test('data-pack purchase and allowance never reach the foreign contract', async () => {
    const buy = await portal('post', '/api/v1/portal/data-packs/7/purchase');
    expect(buy.status).toBe(404);
    expect(dataPackService.purchasePack).not.toHaveBeenCalled();

    const allowance = await portal('get', '/api/v1/portal/usage/allowance');
    expect(allowance.status).toBe(200);
    expect(allowance.body.data).toBeNull();
    expect(dataPackService.getEffectiveAllowance).not.toHaveBeenCalled();

    const mine = await portal('get', '/api/v1/portal/data-packs/my-purchases');
    expect(mine.body.data).toEqual([]);
    expect(dataPackService.listPurchases).not.toHaveBeenCalled();
  });

  test('speed-test results list only own-org jobs on the subscriber\'s own contract', async () => {
    const res = await portal('get', '/api/v1/portal/speed-test/results', 30);
    expect(res.status).toBe(200);
    expect(res.body.data.map(j => j.id)).toEqual([401]);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('autopay and consent are bound to the subscriber\'s organization', () => {
  test('a foreign-org autopay profile is not reported and cannot be revoked', async () => {
    const status = await portal('get', '/api/v1/portal/autopay/status');
    expect(status.status).toBe(200);
    expect(status.body.data.enabled).toBe(false);

    const del = await portal('delete', '/api/v1/portal/autopay');
    expect(del.status).toBe(200);
    expect(T.recurring_payment_profiles[0].status).toBe('active');
  });

  // BIL-06: turning autopay off must also stop the retries already scheduled
  // for the card, or they keep charging it for up to three more days.
  test('disabling autopay cancels the subscriber\'s scheduled retries, bound to their org', async () => {
    const del = await portal('delete', '/api/v1/portal/autopay');
    expect(del.status).toBe(200);

    const [cancel] = writesTo('payment_retries');
    expect(cancel).toBeDefined();
    expect(cancel.sql).toContain("pr.status = 'cancelled'");
    expect(cancel.sql).toContain('rp.client_id = ? AND rp.organization_id <=> ?');
    expect(cancel.params).toEqual([10, ORG_A]);
  });

  test('a foreign-org consent row does not read as acceptance', async () => {
    const res = await portal('get', '/api/v1/portal/privacy-notice');
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(false);

    const accept = await portal('post', '/api/v1/portal/privacy-notice/accept');
    expect(accept.status).toBe(201);
    const [insert] = writesTo('subscriber_consents');
    expect(insert.params.slice(0, 2)).toEqual([ORG_A, 10]);
  });
});
