// =============================================================================
// TNA-36 — running anomaly detection is not a read
// =============================================================================
// POST /analytics/anomalies/detect writes analytics_anomalies rows and scans up
// to 500 devices, but only needed analytics_anomalies.view, and its window
// (samples read per device) had no upper bound.

const express = require('express');
const request = require('supertest');

let mockHeld = [];
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => [[]]) }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 3, role: 'support', organizationId: 5 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 5; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: slug => (_req, res, next) => (mockHeld.includes(slug)
    ? next()
    : res.status(403).json({ error: { code: 'FORBIDDEN', message: slug } })),
}));

const db = require('../src/config/database');
const analyticsService = require('../src/services/analyticsService');
const router = require('../src/routes/analyticsAI');

const app = express();
app.use(express.json());
app.use('/analytics', router);

beforeEach(() => {
  jest.clearAllMocks();
  mockHeld = [];
});

test('a viewer of anomalies cannot run detection', async () => {
  mockHeld = ['analytics_anomalies.view'];
  const spy = jest.spyOn(analyticsService, 'detectAnomalies');
  const res = await request(app).post('/analytics/anomalies/detect');

  expect(res.status).toBe(403);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test('the acknowledge grant runs detection', async () => {
  mockHeld = ['analytics_anomalies.acknowledge'];
  const res = await request(app).post('/analytics/anomalies/detect');
  expect(res.status).toBe(200);
});

test('the per-device sample window is capped at 2000', async () => {
  db.query
    .mockResolvedValueOnce([[{ device_id: 1 }]]) // devices
    .mockResolvedValueOnce([[]]);                 // samples
  await analyticsService.detectAnomalies(5, { window: 10000000 });

  const samplesSql = db.query.mock.calls[1][0];
  expect(samplesSql).toMatch(/LIMIT 2000\b/);
});
