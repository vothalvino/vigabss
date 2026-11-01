// =============================================================================
// DAL-12 — pool utilization covers every pool with one grouped query
// =============================================================================
// GET /ip-pools/utilization used IpPool.findAll's default 50-row page, so pools
// past the 50th had no utilization, and it ran one COUNT per pool in parallel.

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, organizationId: 4 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 4; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({ requirePermission: () => (_req, _res, next) => next() }));

const db = require('../src/config/database');
const router = require('../src/routes/ipPools');

const app = express();
app.use('/ip-pools', router);

test('all 60 pools are reported from two queries', async () => {
  const pools = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, name: `P${i + 1}`, network: '10.0.0.0', subnet_mask: 24, ip_version: 4,
  }));
  db.query
    .mockResolvedValueOnce([pools])
    .mockResolvedValueOnce([[
      { pool_id: 60, type: 'static', cnt: 2 },
      { pool_id: 60, type: 'dynamic', cnt: 3 },
    ]]);

  const res = await request(app).get('/ip-pools/utilization');

  expect(res.status).toBe(200);
  expect(res.body.data).toHaveLength(60);
  expect(res.body.data[59]).toMatchObject({ pool_id: 60, assigned: 5, by_type: { static: 2, dynamic: 3, reserved: 0 } });
  expect(db.query).toHaveBeenCalledTimes(2);
  expect(db.query.mock.calls[0][0]).not.toMatch(/LIMIT/);
  expect(db.query.mock.calls[1][0]).toMatch(/GROUP BY a\.pool_id, a\.type/);
  expect(db.query.mock.calls[1][1]).toEqual([4]);
});
