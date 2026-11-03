'use strict';

// =============================================================================
// REG-06 — case-scoped preservation holds
// =============================================================================
// Retention kept connection, accounting and CGNAT rows only when a matched IP
// lookup pinned evidence; an ambiguous or unavailable lookup, a government
// request's date range and a DSAR legal hold preserved nothing. A
// preservation hold now keeps every matching row until it is released.
// tests/test_preservation_holds.sql runs the predicate against MySQL in CI.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn(callback => callback()),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 7, role: 'admin', organizationId: 10 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 10; next(); },
}));
const mockPermissions = new Set(['gov_data_requests.manage', 'dsar_requests.manage']);
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  userHasPermission: jest.fn(async (_req, permission) => mockPermissions.has(permission)),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const retentionService = require('../src/services/retentionService');
const regulatoryCompliance = require('../src/routes/regulatoryCompliance');

const app = express();
app.use(express.json());
app.use('/api/v1/regulatory-compliance', regulatoryCompliance);
app.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ error: error.code || 'INTERNAL_ERROR', message: error.message });
});

const squash = s => s.replace(/\s+/g, ' ').trim();

async function purgeSql(table) {
  db.query.mockReset();
  db.query.mockResolvedValue([{ affectedRows: 0 }]);
  await retentionService.purgeTable(table, 730);
  return db.query.mock.calls[0][0];
}

describe('the retention purge keeps rows an active hold covers', () => {
  test.each([
    ['connection_logs', ['client_id', 'contract_id', 'username', 'framed_ip']],
    ['radius_accounting_events', ['client_id', 'contract_id', 'username', 'framed_ip']],
    ['radius_accounting_usage_daily', ['client_id', 'contract_id', 'username']],
    ['cgnat_attribution_bindings', ['client_id', 'contract_id', 'username', 'public_ipv4', 'private_ipv4']],
    ['cgnat_binding_events', ['client_id', 'contract_id', 'username', 'public_ipv4']],
  ])('%s', async (table, columns) => {
    const sql = await purgeSql(table);
    expect(sql).toMatch(/FROM preservation_holds ph/);
    expect(sql).toMatch(/ph\.released_at IS NULL/);
    expect(sql).toMatch(/ph\.held_from <=/);
    expect(sql).toMatch(/ph\.held_to IS NULL OR ph\.held_to >=/);
    for (const column of columns) expect(sql).toContain(`.${column}`);
  });

  test('the predicate MySQL runs in tests/test_preservation_holds.sql is the one the purge uses', async () => {
    const file = fs.readFileSync(path.join(__dirname, 'test_preservation_holds.sql'), 'utf8');
    const block = file.split('-- BEGIN connection_logs preservation predicate\n')[1].split('\n-- END connection_logs preservation predicate')[0];
    expect(squash(await purgeSql('connection_logs'))).toContain(squash(block));
  });
});

function fakeConnection(handlers) {
  const conn = {
    beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(async () => {}), release: jest.fn(),
    execute: jest.fn(async (sql, params) => {
      for (const [pattern, answer] of handlers) {
        if (pattern.test(sql)) return typeof answer === 'function' ? answer(sql, params) : answer;
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
  db.getConnection.mockResolvedValue(conn);
  return conn;
}

const GOV = {
  id: 55, organization_id: 10, status: 'processing', authority_ref: 'FGR/1', client_id: 3, contract_id: null,
  ip_address: '8.8.8.8', date_from: new Date('2026-01-01T00:00:00Z'), date_to: new Date('2026-01-31T00:00:00Z'), observed_at: null,
};

describe('POST /gov-data-requests/:id/preservation-holds', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockResolvedValue([[{ id: 900, gov_data_request_id: 55 }]]);
  });

  test("defaults the subject and range to the request's own, in whole UTC days", async () => {
    const conn = fakeConnection([
      [/FROM gov_data_requests/, [[GOV]]],
      [/FROM clients/, [[{ id: 3 }]]],
      [/INSERT INTO preservation_holds/, [{ insertId: 900 }]],
    ]);

    const res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds').send({});

    expect(res.status).toBe(201);
    const [, params] = conn.execute.mock.calls.find(([sql]) => /INSERT INTO preservation_holds/.test(sql));
    expect(params).toEqual([10, 55, null, 3, null, null, '8.8.8.8',
      '2026-01-01 00:00:00.000', '2026-01-31 23:59:59.999', 'Government request FGR/1', 7]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('works while the request awaits legal review, and after an inconclusive lookup', async () => {
    fakeConnection([
      [/FROM gov_data_requests/, [[{ ...GOV, status: 'pending_legal_review', client_id: null }]]],
      [/INSERT INTO preservation_holds/, [{ insertId: 901 }]],
    ]);
    const res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds')
      .send({ username: 'pppoe-user-9' });
    expect(res.status).toBe(201);
  });

  test('a closed request cannot be held', async () => {
    fakeConnection([[/FROM gov_data_requests/, [[{ ...GOV, status: 'fulfilled' }]]]]);
    const res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds').send({});
    expect(res.status).toBe(409);
  });

  test('a hold needs a subject and a range', async () => {
    fakeConnection([[/FROM gov_data_requests/, [[{ ...GOV, client_id: null, ip_address: null }]]]]);
    let res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds').send({});
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/needs a subject/);

    fakeConnection([[/FROM gov_data_requests/, [[{ ...GOV, date_from: null, date_to: null }]]], [/FROM clients/, [[{ id: 3 }]]]]);
    res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds').send({});
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/held_from is required/);
  });

  test("another organization's client is refused", async () => {
    fakeConnection([[/FROM gov_data_requests/, [[GOV]]], [/FROM clients/, [[]]]]);
    const res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds').send({});
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/not a client of this organization/);
  });

  test('an invalid IP address is refused', async () => {
    fakeConnection([[/FROM gov_data_requests/, [[GOV]]], [/FROM clients/, [[{ id: 3 }]]]]);
    const res = await request(app).post('/api/v1/regulatory-compliance/gov-data-requests/55/preservation-holds')
      .send({ ip_address: 'not-an-ip' });
    expect(res.status).toBe(422);
  });
});

describe('a DSAR legal hold preserves the client', () => {
  test('it places an open-ended client hold in the same transaction as the status change', async () => {
    const conn = fakeConnection([
      [/FROM dsar_requests/, [[{ id: 4, client_id: 3, status: 'in_review' }]]],
      [/UPDATE dsar_requests/, [{ affectedRows: 1 }]],
      [/SELECT id FROM preservation_holds/, [[]]],
      [/FROM clients/, [[{ id: 3 }]]],
      [/INSERT INTO preservation_holds/, [{ insertId: 77 }]],
    ]);

    const res = await request(app).put('/api/v1/regulatory-compliance/dsar-requests/4/legal-hold')
      .send({ legal_hold_reason: 'Litigation' });

    expect(res.status).toBe(200);
    expect(res.body.preservation_hold_id).toBe(77);
    const [, params] = conn.execute.mock.calls.find(([sql]) => /INSERT INTO preservation_holds/.test(sql));
    expect(params).toEqual([10, null, 4, 3, null, null, null, '1970-01-01 00:00:01.000', null, 'Litigation', 7]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('a fulfilled request cannot be put on hold', async () => {
    const conn = fakeConnection([[/FROM dsar_requests/, [[{ id: 4, client_id: 3, status: 'fulfilled' }]]]]);
    const res = await request(app).put('/api/v1/regulatory-compliance/dsar-requests/4/legal-hold').send({});
    expect(res.status).toBe(409);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('releasing the legal hold releases its preservation holds', async () => {
    const conn = fakeConnection([
      [/UPDATE dsar_requests/, [{ affectedRows: 1 }]],
      [/UPDATE preservation_holds/, [{ affectedRows: 1 }]],
    ]);
    const res = await request(app).put('/api/v1/regulatory-compliance/dsar-requests/4/release-legal-hold')
      .send({ reason: 'Litigation settled' });
    expect(res.status).toBe(200);
    expect(res.body.released_preservation_holds).toBe(1);
    const [, params] = conn.execute.mock.calls.find(([sql]) => /UPDATE preservation_holds/.test(sql));
    expect(params).toEqual([7, 'Litigation settled', 4, 10]);
  });
});

describe('PUT /preservation-holds/:id/release', () => {
  beforeEach(() => { db.query.mockReset(); });

  test("needs the manage permission of the hold's own case", async () => {
    mockPermissions.delete('dsar_requests.manage');
    try {
      db.query.mockResolvedValueOnce([[{ id: 77, gov_data_request_id: null, dsar_request_id: 4 }]]);
      const res = await request(app).put('/api/v1/regulatory-compliance/preservation-holds/77/release').send({ reason: 'x' });
      expect(res.status).toBe(403);
    } finally {
      mockPermissions.add('dsar_requests.manage');
    }
  });

  test('releases with a reason', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 78, gov_data_request_id: 55, dsar_request_id: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 78, released_at: new Date() }]]);
    const res = await request(app).put('/api/v1/regulatory-compliance/preservation-holds/78/release').send({ reason: 'Case closed' });
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1][1]).toEqual([7, 'Case closed', 78, 10]);
  });

  test('a reason is required', async () => {
    db.query.mockResolvedValueOnce([[{ id: 78, gov_data_request_id: 55, dsar_request_id: null }]]);
    const res = await request(app).put('/api/v1/regulatory-compliance/preservation-holds/78/release').send({});
    expect(res.status).toBe(422);
  });
});
