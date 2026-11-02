// =============================================================================
// DAL-16 — the active-session summary scans connection_logs once, not once
// per NAS
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');

test('one grouped query yields per-NAS totals and per-port breakdowns', async () => {
  db.query.mockResolvedValue([[
    { nas_id: 1, nas_name: 'core', nas_ip: '10.0.0.1', nas_port_id: 'ether1', session_count: 3 },
    { nas_id: 1, nas_name: 'core', nas_ip: '10.0.0.1', nas_port_id: 'ether2', session_count: 5 },
    { nas_id: 2, nas_name: 'edge', nas_ip: '10.0.0.2', nas_port_id: 'ether1', session_count: 4 },
  ]]);
  const res = await request(app).get('/api/v1/connection-logs/active/summary');
  expect(res.status).toBe(200);
  const scans = db.query.mock.calls.filter(([sql]) => /FROM connection_logs cl/.test(sql));
  expect(scans).toHaveLength(1);
  expect(scans[0][0]).toMatch(/GROUP BY cl\.nas_id, n\.name, n\.ip_address, cl\.nas_port_id/);
  expect(res.body.data.map((n) => [n.nas_id, n.session_count, n.ports.map((p) => p.nas_port_id)])).toEqual([
    [1, 8, ['ether2', 'ether1']],
    [2, 4, ['ether1']],
  ]);
  expect(res.body.meta).toEqual({ total_sessions: 12, nas_count: 2 });
});
