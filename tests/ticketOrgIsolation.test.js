// =============================================================================
// VigaBSS 5.0 — Tickets: organization isolation of subresources and FKs (TNB-06)
// =============================================================================
// ticket_comments / ticket_relations / ticket_time_logs have no organization_id
// column; the parent ticket is their only tenant boundary. The old
// guardBillingTicketMw only 404'd a billing ticket FOUND in req.orgId and
// fell through on a miss, so an org-A user could read, inject, edit and delete
// org-B comments, time logs and relations, merge their own ticket INTO an
// org-B ticket, and create/re-point tickets at another org's client, contract
// or user (which then surfaced in that org's subscriber portal).
//
// These tests drive the real routers, RBAC middleware and models against a
// small SQL-aware fake that holds rows in two organizations. Its WHERE
// evaluator applies whatever predicates a statement actually binds, so an
// unscoped statement (the old behaviour) really does see the foreign row.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// The caller is an ordinary (non-global) member of whatever org the token names.
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'technician',
    membershipRole: 'technician',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

jest.mock('../src/services/jobQueueService', () => ({
  add: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const jobQueue = require('../src/services/jobQueueService');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const ORG_A = 1; // the caller
const ORG_B = 2; // the victim

const staffToken = jwt.sign(
  { sub: 50, email: 'tech@isp-a.example', role: 'technician', orgId: ORG_A },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);
const portalToken = signPortalAccessToken({ clientId: 10 }, 900);

const ALL_TICKET_PERMS = [
  'tickets.view', 'tickets.create', 'tickets.update', 'tickets.delete',
  'ticket_relations.view', 'ticket_relations.manage',
  'ticket_time_logs.view', 'ticket_time_logs.manage',
  'ticket_attachments.view',
];

// ---------------------------------------------------------------------------
// Two-org fixture + SQL-aware fake
// ---------------------------------------------------------------------------
function freshTables() {
  return {
    users: [
      { id: 50, organization_id: ORG_A, email: 'tech@isp-a.example', role: 'technician', status: 'active', deleted_at: null },
      { id: 60, organization_id: ORG_B, email: 'tech@isp-b.example', role: 'technician', status: 'active', deleted_at: null },
    ],
    clients: [
      { id: 10, organization_id: ORG_A, name: 'Alice (A)', email: 'alice@a.example', status: 'active', deleted_at: null },
      { id: 20, organization_id: ORG_B, name: 'Bob (B)', email: 'bob@b.example', status: 'active', deleted_at: null },
    ],
    contracts: [
      { id: 11, organization_id: ORG_A, client_id: 10, status: 'active', deleted_at: null },
      { id: 21, organization_id: ORG_B, client_id: 20, status: 'active', deleted_at: null },
    ],
    tickets: [
      { id: 1500, organization_id: ORG_A, client_id: 10, subject: 'A outage', category: 'technical', status: 'open', deleted_at: null },
      { id: 1501, organization_id: ORG_A, client_id: 10, subject: 'A archived', category: 'technical', status: 'closed', deleted_at: '2026-10-01 00:00:00' },
      { id: 1502, organization_id: ORG_A, client_id: 10, subject: 'A related', category: 'technical', status: 'open', deleted_at: null },
      { id: 2003, organization_id: ORG_B, client_id: 20, subject: 'ORG-B SECRET SUBJECT', category: 'technical', status: 'open', deleted_at: null },
      // A ticket org B holds against client_id 10 (as the old FK hole allowed
      // from the other direction): org A's portal subscriber must never see it.
      { id: 2004, organization_id: ORG_B, client_id: 10, subject: 'ORG-B PLANTED SUBJECT', category: 'technical', status: 'open', deleted_at: null },
    ],
    ticket_comments: [
      { id: 71, ticket_id: 1500, user_id: 50, body: 'A note', is_internal: 0, deleted_at: null },
      { id: 72, ticket_id: 2003, user_id: 60, body: 'ORG-B INTERNAL NOTE', is_internal: 1, deleted_at: null },
      { id: 73, ticket_id: 2004, user_id: 60, body: 'ORG-B PLANTED COMMENT', is_internal: 0, deleted_at: null },
    ],
    ticket_time_logs: [
      { id: 81, ticket_id: 1500, user_id: 50, minutes: 30, work_date: '2026-10-01', description: 'A time' },
      { id: 82, ticket_id: 2003, user_id: 60, minutes: 45, work_date: '2026-10-01', description: 'ORG-B TIME LOG' },
    ],
    ticket_relations: [
      { id: 91, ticket_id_a: 1500, ticket_id_b: 1502, relation_type: 'related' },
      // Pre-existing cross-org relation (created through the old hole).
      { id: 92, ticket_id_a: 1500, ticket_id_b: 2003, relation_type: 'related' },
    ],
    ticket_attachments: [],
  };
}

let T;
let writes;
let granted;
let nextId;

const same = (a, b) => (a === null || a === undefined ? null : String(a))
  === (b === null || b === undefined ? null : String(b));

// Apply the predicates the statement binds after WHERE (col = ?, col <=> ?,
// col IS [NOT] NULL), in placeholder order. Unknown constructs are ignored, so
// a statement that does not bind organization_id genuinely is unscoped here.
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

function fakeQuery(sql, params = []) {
  const table = tableOf(sql);

  // User.count({ where: { id }, orgId }) — organization visibility of a user.
  if (/COUNT\(\*\) AS total FROM users u\b/.test(sql)) {
    const [orgId, , id] = params;
    const total = T.users.filter(u => same(u.id, id) && same(u.organization_id, orgId) && !u.deleted_at).length;
    return [[{ total }]];
  }

  // GET /:id/relations — join both sides, honouring any org binding on them.
  if (/FROM ticket_relations tr/.test(sql)) {
    const scoped = /ta\.organization_id = \?/.test(sql);
    const orgId = scoped ? params[0] : null;
    const id = params[params.length - 1];
    const byId = tid => T.tickets.find(t => same(t.id, tid));
    const rows = T.ticket_relations
      .filter(r => same(r.ticket_id_a, id) || same(r.ticket_id_b, id))
      .map(r => ({ r, ta: byId(r.ticket_id_a), tb: byId(r.ticket_id_b) }))
      .filter(({ ta, tb }) => ta && tb && (!scoped || (same(ta.organization_id, orgId) && same(tb.organization_id, orgId))))
      .map(({ r, ta, tb }) => ({
        ...r,
        ticket_a_subject: ta.subject, ticket_b_subject: tb.subject,
        ticket_a_category: ta.category, ticket_b_category: tb.category,
      }));
    return [rows];
  }

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
    const rows = T[table] || [];
    // DELETE FROM ticket_relations ... AND (ticket_id_a = ? OR ticket_id_b = ?)
    if (/ticket_id_a = \? OR ticket_id_b = \?/.test(sql)) {
      const [relId, tid] = params;
      const n = rows.filter(r => same(r.id, relId) && (same(r.ticket_id_a, tid) || same(r.ticket_id_b, tid))).length;
      return [{ affectedRows: n }];
    }
    const hit = matchWhere(rows, sql, params);
    // The one SET the suite needs applied: Model.restore's un-delete.
    if (/SET deleted_at = NULL/.test(sql)) hit.forEach(r => { r.deleted_at = null; });
    return [{ affectedRows: hit.length }];
  }

  // SELECT
  const rows = matchWhere(T[table] || [], sql, params);
  if (/COUNT\(\*\)\s+AS\s+total/i.test(sql)) return [[{ total: rows.length }]];
  return [rows];
}

const childWrites = () => writes.filter(({ sql }) => /ticket_comments|ticket_relations|ticket_time_logs|ticket_attachments/.test(sql));
const ticketWrites = () => writes.filter(({ sql }) => /^\s*(INSERT INTO|UPDATE)\s+`?tickets`?\b/i.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  T = freshTables();
  writes = [];
  nextId = 5000;
  granted = ALL_TICKET_PERMS;
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  db.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  mockTxConnection(db);
});

afterEach(() => jest.restoreAllMocks());

const staff = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${staffToken}`);
const portal = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${portalToken}`);

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
describe('ticket comments — another organization\'s ticket is 404', () => {
  test('GET /tickets/:id/comments does not return org B comments', async () => {
    const res = await staff('get', '/api/v1/tickets/2003/comments');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B INTERNAL NOTE');
  });

  test('POST /tickets/:id/comments injects nothing and enqueues no AI triage', async () => {
    const res = await staff('post', '/api/v1/tickets/2003/comments').send({ body: 'injected', is_internal: false });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
    expect(jobQueue.add).not.toHaveBeenCalled();
  });

  test('PUT /tickets/:id/comments/:commentId edits nothing', async () => {
    const res = await staff('put', '/api/v1/tickets/2003/comments/72').send({ body: 'defaced' });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('DELETE /tickets/:id/comments/:commentId deletes nothing', async () => {
    const res = await staff('delete', '/api/v1/tickets/2003/comments/72');
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('own ticket: comments read and write still work', async () => {
    const list = await staff('get', '/api/v1/tickets/1500/comments');
    expect(list.status).toBe(200);
    expect(list.body.data.map(c => c.id)).toEqual([71]);

    const created = await staff('post', '/api/v1/tickets/1500/comments').send({ body: 'hello' });
    expect(created.status).toBe(201);
    expect(jobQueue.add).toHaveBeenCalledWith('ai-triage', expect.objectContaining({ orgId: ORG_A, ticketId: 1500 }));

    const edited = await staff('put', '/api/v1/tickets/1500/comments/71').send({ body: 'edited' });
    expect(edited.status).toBe(200);

    const deleted = await staff('delete', '/api/v1/tickets/1500/comments/71');
    expect(deleted.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
describe('ticket relations', () => {
  test('GET /tickets/:id/relations on an org B ticket is 404', async () => {
    const res = await staff('get', '/api/v1/tickets/2003/relations');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B SECRET SUBJECT');
  });

  test('POST /tickets/:id/relations on an org B ticket is 404', async () => {
    const res = await staff('post', '/api/v1/tickets/2003/relations').send({ related_ticket_id: 1500 });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('POST relating an own ticket to an org B ticket is 422', async () => {
    const res = await staff('post', '/api/v1/tickets/1500/relations').send({ related_ticket_id: 2003 });
    expect(res.status).toBe(422);
    expect(childWrites()).toEqual([]);
  });

  test('DELETE /tickets/:id/relations/:relId on an org B ticket is 404', async () => {
    const res = await staff('delete', '/api/v1/tickets/2003/relations/92');
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('own ticket: a pre-existing cross-org relation never surfaces the foreign subject', async () => {
    const res = await staff('get', '/api/v1/tickets/1500/relations');
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => r.id)).toEqual([91]);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B SECRET SUBJECT');
  });

  test('own ticket: relating two own tickets still works', async () => {
    const res = await staff('post', '/api/v1/tickets/1500/relations').send({ related_ticket_id: 1502 });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Time logs
// ---------------------------------------------------------------------------
describe('ticket time logs — another organization\'s ticket is 404', () => {
  test('GET does not return org B time logs', async () => {
    const res = await staff('get', '/api/v1/tickets/2003/time-logs');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B TIME LOG');
  });

  test('POST writes nothing', async () => {
    const res = await staff('post', '/api/v1/tickets/2003/time-logs').send({ minutes: 10, work_date: '2026-10-02' });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('PUT writes nothing', async () => {
    const res = await staff('put', '/api/v1/tickets/2003/time-logs/82').send({ minutes: 999, work_date: '2026-10-02' });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('DELETE writes nothing', async () => {
    const res = await staff('delete', '/api/v1/tickets/2003/time-logs/82');
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('own ticket: time logs still listed', async () => {
    const res = await staff('get', '/api/v1/tickets/1500/time-logs');
    expect(res.status).toBe(200);
    expect(res.body.data.map(l => l.id)).toEqual([81]);
  });
});

// ---------------------------------------------------------------------------
// Detail, attachments, restore
// ---------------------------------------------------------------------------
describe('other /:id routes', () => {
  test('GET /tickets/:id and attachments list are 404 for an org B ticket', async () => {
    expect((await staff('get', '/api/v1/tickets/2003')).status).toBe(404);
    expect((await staff('get', '/api/v1/tickets/2003/attachments')).status).toBe(404);
  });

  test('restore: another org\'s ticket is 404; an own soft-deleted ticket passes the guard', async () => {
    const foreign = await staff('post', '/api/v1/tickets/2003/restore');
    expect(foreign.status).toBe(404);
    expect(ticketWrites()).toEqual([]);

    const own = await staff('post', '/api/v1/tickets/1501/restore');
    expect(own.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------
describe('POST /tickets/:id/merge', () => {
  test('an org B merge TARGET is 404: own comments are not moved into it', async () => {
    const res = await staff('post', '/api/v1/tickets/2003/merge').send({ source_ticket_id: 1500 });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
    expect(ticketWrites()).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B SECRET SUBJECT');
  });

  test('an org B merge SOURCE is 404', async () => {
    const res = await staff('post', '/api/v1/tickets/1500/merge').send({ source_ticket_id: 2003 });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('merging two own tickets still works', async () => {
    const res = await staff('post', '/api/v1/tickets/1500/merge').send({ source_ticket_id: 1502 });
    expect(res.status).toBe(200);
    expect(res.body.data.target.id).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// Create / update FKs
// ---------------------------------------------------------------------------
describe('ticket foreign keys must belong to the caller\'s organization', () => {
  const base = { subject: 'x', category: 'technical' };

  test.each([
    ['client_id', { client_id: 20 }],
    ['contract_id', { client_id: 10, contract_id: 21 }],
    ['assigned_to', { client_id: 10, assigned_to: 60 }],
  ])('POST /tickets with a foreign %s is 422 and inserts nothing', async (field, fks) => {
    const res = await staff('post', '/api/v1/tickets').send({ ...base, ...fks });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(field);
    expect(ticketWrites()).toEqual([]);
  });

  test('POST /tickets with own client, contract and assignee is 201', async () => {
    const res = await staff('post', '/api/v1/tickets').send({ ...base, client_id: 10, contract_id: 11, assigned_to: 50 });
    expect(res.status).toBe(201);
    expect(ticketWrites()).toHaveLength(1);
  });

  test('POST /tickets/from-alert with a foreign client_id is 422', async () => {
    const res = await staff('post', '/api/v1/tickets/from-alert')
      .send({ alert_event_id: 1, client_id: 20, subject: 'alert' });
    expect(res.status).toBe(422);
    expect(ticketWrites()).toEqual([]);
  });

  test('POST /tickets/from-alert with an own client_id is 201', async () => {
    const res = await staff('post', '/api/v1/tickets/from-alert')
      .send({ alert_event_id: 1, client_id: 10, subject: 'alert' });
    expect(res.status).toBe(201);
  });

  test.each([
    ['PATCH', { client_id: 20 }],
    ['PATCH', { contract_id: 21 }],
    ['PATCH', { assigned_to: 60 }],
    ['PUT', { client_id: 20 }],
  ])('%s /tickets/:id re-pointing at a foreign FK %j is 422', async (verb, body) => {
    const res = await staff(verb.toLowerCase(), '/api/v1/tickets/1500').send(body);
    expect(res.status).toBe(422);
    expect(ticketWrites()).toEqual([]);
  });

  test('PATCH /tickets/:id to an own assignee still works', async () => {
    const res = await staff('patch', '/api/v1/tickets/1500').send({ assigned_to: 50 });
    expect(res.status).toBe(200);
  });

  test('PATCH /tickets/:id on an org B ticket is 404', async () => {
    const res = await staff('patch', '/api/v1/tickets/2003').send({ priority: 'low' });
    expect(res.status).toBe(404);
    expect(ticketWrites()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Portal: scoped to the subscriber's organization as well as client_id
// ---------------------------------------------------------------------------
describe('portal tickets are bound to the subscriber\'s organization', () => {
  test('GET /portal/tickets lists only own-org tickets', async () => {
    const res = await portal('get', '/api/v1/portal/tickets');
    expect(res.status).toBe(200);
    expect(res.body.data.map(t => t.id).sort()).toEqual([1500, 1502]);
    expect(res.body.meta.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B PLANTED SUBJECT');
  });

  test('GET /portal/tickets/:id of another org\'s ticket naming this client is 404', async () => {
    const res = await portal('get', '/api/v1/portal/tickets/2004');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ORG-B PLANTED');
  });

  test('POST /portal/tickets/:id/comments on that ticket is 404 and writes nothing', async () => {
    const res = await portal('post', '/api/v1/portal/tickets/2004/comments').send({ body: 'hi' });
    expect(res.status).toBe(404);
    expect(childWrites()).toEqual([]);
  });

  test('own ticket detail still works, and a new portal ticket lands in the client\'s org', async () => {
    const detail = await portal('get', '/api/v1/portal/tickets/1500');
    expect(detail.status).toBe(200);
    expect(detail.body.data.comments.map(c => c.id)).toEqual([71]);

    const created = await portal('post', '/api/v1/portal/tickets').send({ subject: 'help', description: 'down' });
    expect(created.status).toBe(201);
    const insert = ticketWrites()[0];
    expect(insert.params[0]).toBe(ORG_A);
    expect(insert.params[1]).toBe(10);
  });
});
