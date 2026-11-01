// =============================================================================
// VigaBSS 5.0 — Credit notes post to the balance ledger when ISSUED
// =============================================================================
// Contract (migration 465):
//   * a draft credit note posts nothing to client_balance_ledger;
//   * the draft -> issued/applied transition (PUT /credit-notes/:id) posts the
//     note's FINAL total exactly once, in the update transaction and row lock;
//   * a note created directly as issued/applied still posts at creation;
//   * a posted note cannot return to draft and cancelled is terminal;
//   * adding a line to a draft moves its header subtotal/tax/total.
// Extended by migration 466 to the full invariant (net credit == total while
// issued/applied, 0 while draft/cancelled/soft-deleted):
//   * cancel and soft-delete append one reversal debit, under the row lock;
//   * restore re-posts a posted note; a total change posts the delta;
//   * a live CFDI blocks cancel/delete/total change and nothing moves.
//
// The fake below keeps rows in two organizations, applies the SET clauses the
// code really sends, and gives every pooled connection a real per-row
// FOR UPDATE lock held until commit/rollback, so concurrent issues genuinely
// interleave and only the lock can serialize them.
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
    authorizationRole: 'billing',
    membershipRole: 'billing',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/billingService', () => ({
  ...jest.requireActual('../src/services/billingService'),
  // Tax coherence has its own suite (creditNoteFiscalGuards); it reads client
  // and org fiscal profiles this fixture does not model.
  assertTaxCoherent: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');

const ORG_A = 1;
const ORG_B = 2;

const token = jwt.sign(
  { sub: 50, email: 'billing@isp-a.example', role: 'billing', orgId: ORG_A },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

const note = (over) => ({
  organization_id: ORG_A, client_id: 10, invoice_id: null, credit_note_number: null,
  reason: 'billing_error', subtotal: '100.00', tax_rate: '0.1600', tax_amount: '16.00',
  total: '116.00', currency: 'MXN', status: 'draft', notes: null, deleted_at: null, ...over,
});

function freshTables() {
  return {
    users: [
      { id: 50, organization_id: ORG_A, email: 'billing@isp-a.example', role: 'billing', status: 'active', deleted_at: null },
    ],
    credit_notes: [
      note({ id: 700, credit_note_number: 'CN-A-700' }),
      // Pre-465 draft still carrying its create-time credit (unreversed).
      note({ id: 701, credit_note_number: 'CN-A-701' }),
      note({ id: 702, credit_note_number: 'CN-A-702', status: 'issued' }),
      note({ id: 703, credit_note_number: 'CN-A-703', status: 'cancelled' }),
      note({ id: 800, organization_id: ORG_B, client_id: 20, credit_note_number: 'CN-B-800' }),
    ],
    client_balance_ledger: [
      { id: 1, organization_id: ORG_A, client_id: 10, entry_type: 'credit', amount: '116.00', debit: '0.00', credit: '0.00', currency: 'MXN', reference_type: 'credit_note', reference_id: 701 },
      { id: 2, organization_id: ORG_A, client_id: 10, entry_type: 'credit', amount: '116.00', debit: '0.00', credit: '0.00', currency: 'MXN', reference_type: 'credit_note', reference_id: 702 },
    ],
    credit_note_items: [],
    cfdi_documents: [],
    clients: [
      { id: 10, organization_id: ORG_A, deleted_at: null },
      { id: 11, organization_id: ORG_A, deleted_at: null },
      { id: 20, organization_id: ORG_B, deleted_at: null },
    ],
    invoices: [
      { id: 900, organization_id: ORG_A, client_id: 10, deleted_at: null },
      { id: 901, organization_id: ORG_B, client_id: 20, deleted_at: null },
    ],
  };
}

let T;
let nextId;
const locks = new Map();

const same = (a, b) => (a === null || a === undefined ? null : String(a))
  === (b === null || b === undefined ? null : String(b));

function matchWhere(rows, sql, params, start) {
  const at = sql.search(/\bWHERE\b/i);
  if (at < 0) return rows;
  let i = start ?? (sql.slice(0, at).match(/\?/g) || []).length;
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

const money = n => (Math.round(n * 100) / 100).toFixed(2);

function signed(l) {
  const debitType = ['invoice', 'usage_deduction', 'debit'].includes(l.entry_type);
  return (debitType ? Number(l.amount) : -Number(l.amount)) + Number(l.debit || 0) - Number(l.credit || 0);
}

function fakeQuery(sql, params = []) {
  const table = tableOf(sql);

  if (/COUNT\(\*\) AS total FROM users u\b/.test(sql)) {
    const [orgId, , id] = params;
    return [[{ total: T.users.filter(u => same(u.id, id) && same(u.organization_id, orgId)).length }]];
  }

  if (/SUM\([\s\S]*\) AS net\s+FROM client_balance_ledger/.test(sql)) {
    const [refId, clientId, orgId] = params;
    const net = T.client_balance_ledger
      .filter(l => l.reference_type === 'credit_note' && same(l.reference_id, refId)
        && same(l.client_id, clientId) && same(l.organization_id, orgId))
      .reduce((s, l) => s + signed(l), 0);
    return [[{ net }]];
  }

  // CreditNote.addItem: INSERT ... SELECT scoped to the parent's org.
  if (/INSERT INTO credit_note_items[\s\S]*SELECT cn\.id/.test(sql)) {
    const [description, quantity, unitPrice, taxRateId, cnId, orgId] = params;
    const parent = T.credit_notes.find(c => same(c.id, cnId) && same(c.organization_id, orgId) && !c.deleted_at);
    if (!parent) return [{ affectedRows: 0 }];
    const row = {
      id: nextId++, credit_note_id: parent.id, description, quantity, unit_price: unitPrice,
      tax_rate_id: taxRateId, total: money(Number(quantity) * Number(unitPrice)), deleted_at: null,
    };
    T.credit_note_items.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }

  if (/^\s*INSERT/i.test(sql)) {
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
    if (table === 'credit_notes' && !row.status) row.status = 'draft';
    if (table === 'client_balance_ledger') { row.debit = row.debit ?? '0.00'; row.credit = row.credit ?? '0.00'; }
    if (T[table]) T[table].push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }

  if (/^\s*UPDATE/i.test(sql)) {
    const setPart = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)[1];
    const assigns = setPart.split(',').map(a => a.trim()).filter(Boolean);
    let p = 0;
    const ops = assigns.map((a) => {
      const m = a.match(/^`?(\w+)`?\s*=\s*([\s\S]+)$/);
      const col = m[1];
      const rhs = m[2].trim();
      if (rhs === '?') return { col, kind: 'set', val: params[p++] };
      if (new RegExp(`^\`?${col}\`?\\s*\\+\\s*\\?$`).test(rhs)) return { col, kind: 'add', val: params[p++] };
      if (/^'.*'$/.test(rhs)) return { col, kind: 'set', val: rhs.slice(1, -1) };
      // Soft-delete / restore: deleted_at = NOW() / deleted_at = NULL.
      if (/^NULL$/i.test(rhs)) return { col, kind: 'set', val: null };
      if (/^NOW\(\)$/i.test(rhs)) return { col, kind: 'set', val: '2026-10-29 12:00:00' };
      return { col, kind: 'set', val: rhs };
    });
    const hit = matchWhere(T[table] || [], sql, params, p);
    hit.forEach(r => ops.forEach(({ col, kind, val }) => {
      r[col] = kind === 'add' ? money(Number(r[col]) + Number(val)) : val;
    }));
    return [{ affectedRows: hit.length }];
  }

  const rows = matchWhere(T[table] || [], sql, params).map(r => ({ ...r }));
  if (/COUNT\(\*\)\s+AS\s+total/i.test(sql)) return [[{ total: rows.length }]];
  return [rows];
}

const { setImmediate } = require('node:timers');

const tick = () => new Promise(r => setImmediate(r));

// One fresh connection per getConnection(), each holding real row locks.
function makeConn() {
  const held = new Set();
  const release = () => {
    for (const id of held) { const l = locks.get(id); locks.delete(id); l.resolve(); }
    held.clear();
  };
  const execute = async (sql, params) => {
    if (/FOR UPDATE/.test(sql) && tableOf(sql) === 'credit_notes') {
      const id = String(params[0]);
      if (!held.has(id)) {
        while (locks.has(id)) await locks.get(id).promise;
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        locks.set(id, { promise, resolve });
        held.add(id);
      }
    }
    await tick();
    return fakeQuery(sql, params);
  };
  return {
    beginTransaction: jest.fn(async () => {}),
    commit: jest.fn(async () => release()),
    rollback: jest.fn(async () => release()),
    release: jest.fn(),
    destroy: jest.fn(),
    execute: jest.fn(execute),
    query: jest.fn(execute),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  T = freshTables();
  nextId = 9000;
  locks.clear();
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => [
    'credit_notes.view', 'credit_notes.create', 'credit_notes.update', 'credit_notes.delete',
  ]);
  db.query.mockImplementation(async (sql, params) => { await tick(); return fakeQuery(sql, params); });
  db.getConnection.mockImplementation(async () => makeConn());
});

afterEach(() => jest.restoreAllMocks());

const staff = (method, path) => request(app)[method](path).set('Authorization', `Bearer ${token}`);
const ledgerFor = id => T.client_balance_ledger.filter(l => l.reference_type === 'credit_note' && same(l.reference_id, id));
const cn = id => T.credit_notes.find(c => c.id === id);

describe('creation', () => {
  test('a draft credit note posts nothing to the ledger', async () => {
    const res = await staff('post', '/api/v1/credit-notes').send({
      client_id: 10, reason: 'billing_error', subtotal: 100, tax_amount: 16, total: 116, currency: 'MXN',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    expect(ledgerFor(res.body.data.id)).toEqual([]);
  });

  test('a note created already issued posts its total once, in the caller\'s org', async () => {
    const res = await staff('post', '/api/v1/credit-notes').send({
      client_id: 10, reason: 'billing_error', subtotal: 100, tax_amount: 16, total: 116, currency: 'MXN', status: 'issued',
    });
    expect(res.status).toBe(201);
    const rows = ledgerFor(res.body.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_type: 'credit', organization_id: ORG_A, client_id: 10, currency: 'MXN' });
    expect(Number(rows[0].amount)).toBe(116);
  });
});

describe('cross-organization references', () => {
  test('creating a note for another organization\'s client is 422 and writes nothing', async () => {
    const before = T.credit_notes.length;
    const res = await staff('post', '/api/v1/credit-notes').send({
      client_id: 20, reason: 'billing_error', total: 116, currency: 'MXN', status: 'issued',
    });
    expect(res.status).toBe(422);
    expect(T.credit_notes).toHaveLength(before);
    expect(T.client_balance_ledger.some(l => same(l.client_id, 20))).toBe(false);
  });

  test('creating a note against another organization\'s invoice is 422', async () => {
    const before = T.credit_notes.length;
    const res = await staff('post', '/api/v1/credit-notes').send({
      client_id: 10, invoice_id: 901, reason: 'billing_error', total: 116, currency: 'MXN',
    });
    expect(res.status).toBe(422);
    expect(T.credit_notes).toHaveLength(before);
  });

  test('re-pointing a posted note at another organization\'s client is 422 and the credit stays put', async () => {
    const res = await staff('put', '/api/v1/credit-notes/702').send({ client_id: 20 });
    expect(res.status).toBe(422);
    expect(cn(702).client_id).toBe(10);
    expect(ledgerFor(702)).toHaveLength(1);
  });

  test('an own-org invoice is accepted', async () => {
    const res = await staff('post', '/api/v1/credit-notes').send({
      client_id: 10, invoice_id: 900, reason: 'billing_error', total: 116, currency: 'MXN',
    });
    expect(res.status).toBe(201);
  });
});

describe('issue transition (PUT draft -> issued/applied)', () => {
  test('posts the final total exactly once', async () => {
    const res = await staff('put', '/api/v1/credit-notes/700').send({
      subtotal: 200, tax_amount: 32, total: 232, status: 'issued',
    });
    expect(res.status).toBe(200);
    expect(cn(700).status).toBe('issued');
    const rows = ledgerFor(700);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_type: 'credit', organization_id: ORG_A, client_id: 10 });
    expect(Number(rows[0].amount)).toBe(232);

    // Re-saving the issued note (the edit form always re-sends status) and
    // moving it to applied post nothing more.
    expect((await staff('put', '/api/v1/credit-notes/700').send({ notes: 'x', status: 'issued' })).status).toBe(200);
    expect((await staff('put', '/api/v1/credit-notes/700').send({ status: 'applied' })).status).toBe(200);
    expect(ledgerFor(700)).toHaveLength(1);
  });

  test('two concurrent issues of the same draft post once', async () => {
    const [a, b] = await Promise.all([
      staff('put', '/api/v1/credit-notes/700').send({ status: 'issued' }),
      staff('put', '/api/v1/credit-notes/700').send({ status: 'issued' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = ledgerFor(700);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(116);
  });

  test('a legacy draft that still carries its create-time credit is not credited twice', async () => {
    const res = await staff('put', '/api/v1/credit-notes/701').send({ status: 'issued' });
    expect(res.status).toBe(200);
    expect(ledgerFor(701)).toHaveLength(1);
  });

  test('another organization\'s draft is 404 and posts nothing', async () => {
    const res = await staff('put', '/api/v1/credit-notes/800').send({ status: 'issued' });
    expect(res.status).toBe(404);
    expect(cn(800).status).toBe('draft');
    expect(ledgerFor(800)).toEqual([]);
  });

  test('a posted note cannot return to draft, and cancelled is terminal', async () => {
    const back = await staff('put', '/api/v1/credit-notes/702').send({ status: 'draft' });
    expect(back.status).toBe(422);
    expect(back.body.error.code).toBe('CREDIT_NOTE_STATUS_TRANSITION');
    expect(cn(702).status).toBe('issued');

    const revive = await staff('put', '/api/v1/credit-notes/703').send({ status: 'issued' });
    expect(revive.status).toBe(422);
    expect(revive.body.error.code).toBe('CREDIT_NOTE_STATUS_TRANSITION');
    expect(cn(703).status).toBe('cancelled');
    expect(ledgerFor(703)).toEqual([]);
  });
});

describe('POST /credit-notes/:id/items re-totals the draft header', () => {
  test('the header moves by the stored line total at the header tax rate; no ledger entry', async () => {
    const res = await staff('post', '/api/v1/credit-notes/700/items').send({
      description: 'Downtime credit', quantity: 2, unit_price: 25, amount: 999,
    });
    expect(res.status).toBe(201);
    // 2 x 25 = 50 (never the body amount), tax 16% = 8.
    expect(cn(700)).toMatchObject({ subtotal: '150.00', tax_amount: '24.00', total: '174.00' });
    expect(ledgerFor(700)).toEqual([]);

    // Issuing afterwards posts the re-totalled amount.
    expect((await staff('put', '/api/v1/credit-notes/700').send({ status: 'issued' })).status).toBe(200);
    expect(Number(ledgerFor(700)[0].amount)).toBe(174);
  });

  test('a non-draft note is still 422 and its header does not move', async () => {
    const res = await staff('post', '/api/v1/credit-notes/702/items').send({
      description: 'late', quantity: 1, unit_price: 10, amount: 10,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CREDIT_NOTE_NOT_DRAFT');
    expect(cn(702)).toMatchObject({ subtotal: '100.00', total: '116.00' });
    expect(T.credit_note_items).toEqual([]);
  });
});

// =============================================================================
// The full invariant (migration 466): net ledger credit == total while the
// note is issued/applied, == 0 while it is draft, cancelled or soft-deleted.
// =============================================================================
const netCredit = id => Math.round(-ledgerFor(id).reduce((s, l) => s + signed(l), 0) * 100) / 100 + 0;
const liveCfdi = (creditNoteId, satStatus = 'vigente') => T.cfdi_documents.push({
  id: 5000 + creditNoteId, organization_id: ORG_A, credit_note_id: creditNoteId, uuid: 'U-1', sat_status: satStatus,
});

describe('cancelling a posted note (PUT -> cancelled)', () => {
  test('appends one reversal debit; re-saving the cancelled note posts nothing more', async () => {
    const res = await staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(cn(702).status).toBe('cancelled');
    const rows = ledgerFor(702);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      entry_type: 'debit', organization_id: ORG_A, client_id: 10, currency: 'MXN', reference_type: 'credit_note',
    });
    expect(Number(rows[1].amount)).toBe(116);
    expect(rows[1].description).toMatch(/^Reversal: Credit Note CN-A-702/);
    expect(netCredit(702)).toBe(0);

    expect((await staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled', notes: 'again' })).status).toBe(200);
    expect(ledgerFor(702)).toHaveLength(2);
  });

  test('two concurrent cancels reverse once', async () => {
    const [a, b] = await Promise.all([
      staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' }),
      staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ledgerFor(702)).toHaveLength(2);
    expect(netCredit(702)).toBe(0);
  });

  test('an applied note is reversed too', async () => {
    expect((await staff('put', '/api/v1/credit-notes/702').send({ status: 'applied' })).status).toBe(200);
    expect((await staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' })).status).toBe(200);
    expect(netCredit(702)).toBe(0);
    expect(ledgerFor(702)).toHaveLength(2);
  });

  test('cancelling a draft posts nothing', async () => {
    const res = await staff('put', '/api/v1/credit-notes/700').send({ status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(cn(700).status).toBe('cancelled');
    expect(ledgerFor(700)).toEqual([]);
  });

  test('a note whose CFDI de Egreso is live cannot be cancelled, and nothing is reversed', async () => {
    liveCfdi(702);
    const res = await staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_STAMPED');
    expect(cn(702).status).toBe('issued');
    expect(ledgerFor(702)).toHaveLength(1);
    expect(netCredit(702)).toBe(116);
  });

  test('another organization\'s posted note is 404 and its ledger is untouched', async () => {
    T.credit_notes.push(note({ id: 801, organization_id: ORG_B, client_id: 20, status: 'issued' }));
    T.client_balance_ledger.push({ id: 3, organization_id: ORG_B, client_id: 20, entry_type: 'credit', amount: '116.00', debit: '0.00', credit: '0.00', currency: 'MXN', reference_type: 'credit_note', reference_id: 801 });
    expect((await staff('put', '/api/v1/credit-notes/801').send({ status: 'cancelled' })).status).toBe(404);
    expect((await staff('delete', '/api/v1/credit-notes/801')).status).toBe(404);
    expect(cn(801).status).toBe('issued');
    expect(cn(801).deleted_at).toBeNull();
    expect(ledgerFor(801)).toHaveLength(1);
  });
});

describe('soft-deleting and restoring', () => {
  test('deleting a posted note reverses its credit once; a second delete is 404 and posts nothing', async () => {
    const res = await staff('delete', '/api/v1/credit-notes/702');
    expect(res.status).toBe(204);
    expect(cn(702).deleted_at).not.toBeNull();
    const rows = ledgerFor(702);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ entry_type: 'debit', organization_id: ORG_A, client_id: 10 });
    expect(rows[1].description).toMatch(/^Reversal: .*deleted/);
    expect(netCredit(702)).toBe(0);

    expect((await staff('delete', '/api/v1/credit-notes/702')).status).toBe(404);
    expect(ledgerFor(702)).toHaveLength(2);
  });

  test('two concurrent deletes reverse once', async () => {
    const results = await Promise.all([
      staff('delete', '/api/v1/credit-notes/702'),
      staff('delete', '/api/v1/credit-notes/702'),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([204, 404]);
    expect(ledgerFor(702)).toHaveLength(2);
    expect(netCredit(702)).toBe(0);
  });

  test('deleting a draft posts nothing', async () => {
    expect((await staff('delete', '/api/v1/credit-notes/700')).status).toBe(204);
    expect(ledgerFor(700)).toEqual([]);
  });

  test('a note with a live CFDI is not deleted and keeps its credit', async () => {
    liveCfdi(702);
    const res = await staff('delete', '/api/v1/credit-notes/702');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_STAMPED');
    expect(cn(702).deleted_at).toBeNull();
    expect(netCredit(702)).toBe(116);
  });

  test('restoring a deleted posted note re-posts its total, once', async () => {
    expect((await staff('delete', '/api/v1/credit-notes/702')).status).toBe(204);
    const res = await staff('post', '/api/v1/credit-notes/702/restore');
    expect(res.status).toBe(200);
    expect(cn(702).deleted_at).toBeNull();
    expect(netCredit(702)).toBe(116);
    expect(ledgerFor(702)).toHaveLength(3);
    expect(ledgerFor(702)[2]).toMatchObject({ entry_type: 'credit' });

    // A second restore finds nothing deleted (404) and posts nothing.
    expect((await staff('post', '/api/v1/credit-notes/702/restore')).status).toBe(404);
    expect(ledgerFor(702)).toHaveLength(3);
  });

  test('restoring a deleted cancelled or draft note posts nothing', async () => {
    expect((await staff('delete', '/api/v1/credit-notes/703')).status).toBe(204);
    expect((await staff('post', '/api/v1/credit-notes/703/restore')).status).toBe(200);
    expect(ledgerFor(703)).toEqual([]);

    expect((await staff('delete', '/api/v1/credit-notes/700')).status).toBe(204);
    expect((await staff('post', '/api/v1/credit-notes/700/restore')).status).toBe(200);
    expect(ledgerFor(700)).toEqual([]);
  });
});

describe('changing a posted note', () => {
  test('a total change on an issued note posts the difference (up, then down)', async () => {
    const up = await staff('put', '/api/v1/credit-notes/702').send({ subtotal: 200, tax_amount: 32, total: 232 });
    expect(up.status).toBe(200);
    expect(ledgerFor(702)).toHaveLength(2);
    expect(ledgerFor(702)[1]).toMatchObject({ entry_type: 'credit' });
    expect(Number(ledgerFor(702)[1].amount)).toBe(116);
    expect(netCredit(702)).toBe(232);

    const down = await staff('put', '/api/v1/credit-notes/702').send({ subtotal: 50, tax_amount: 8, total: 58 });
    expect(down.status).toBe(200);
    expect(ledgerFor(702)[2]).toMatchObject({ entry_type: 'debit' });
    expect(Number(ledgerFor(702)[2].amount)).toBe(174);
    expect(ledgerFor(702)[2].description).toMatch(/^Adjustment: /);
    expect(netCredit(702)).toBe(58);

    // Cancelling afterwards reverses the CURRENT net, never more.
    expect((await staff('put', '/api/v1/credit-notes/702').send({ status: 'cancelled' })).status).toBe(200);
    expect(netCredit(702)).toBe(0);
  });

  test('a stamped note\'s total cannot change, so its ledger does not move', async () => {
    liveCfdi(702);
    const res = await staff('put', '/api/v1/credit-notes/702').send({ subtotal: 200, tax_amount: 32, total: 232 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CFDI_STAMPED');
    expect(ledgerFor(702)).toHaveLength(1);
  });

  test('re-pointing a posted note at another client moves the credit, it never stands twice', async () => {
    const res = await staff('put', '/api/v1/credit-notes/702').send({ client_id: 11 });
    expect(res.status).toBe(200);
    const onOld = ledgerFor(702).filter(l => same(l.client_id, 10));
    const onNew = ledgerFor(702).filter(l => same(l.client_id, 11));
    expect(onOld.reduce((s, l) => s + signed(l), 0)).toBe(0);
    expect(onNew).toHaveLength(1);
    expect(onNew[0]).toMatchObject({ entry_type: 'credit', organization_id: ORG_A });
    expect(Number(onNew[0].amount)).toBe(116);
  });

  test('an issued legacy note with no ledger row is topped up on its next write, once', async () => {
    T.credit_notes.push(note({ id: 704, credit_note_number: 'RCN-1-1', status: 'issued' }));
    expect((await staff('put', '/api/v1/credit-notes/704').send({ notes: 'touch' })).status).toBe(200);
    expect(netCredit(704)).toBe(116);
    expect((await staff('put', '/api/v1/credit-notes/704').send({ notes: 'touch again' })).status).toBe(200);
    expect(ledgerFor(704)).toHaveLength(1);
  });
});
