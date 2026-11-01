// =============================================================================
// FE-17 — staff session failures do not spend the portal's session budget
// =============================================================================
// One sessionLimiter instance (failures only, per IP) covered both the staff
// and the portal /me, /refresh and /logout routes, and the staff SPA's boot
// probe sent four failing staff requests on every portal page load. About 60
// portal loads from one CGNAT address exhausted the budget the portal's own
// refresh needs, and the subscriber was signed out.
// =============================================================================

process.env.RATE_LIMIT_SESSION = '3';

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const request = require('supertest');
const app = require('../src/app');

afterAll(() => { delete process.env.RATE_LIMIT_SESSION; });

test('exhausting the staff session budget leaves the portal one intact', async () => {
  for (let i = 0; i < 4; i++) await request(app).get('/api/v1/auth/me');
  const staff = await request(app).get('/api/v1/auth/me');
  expect(staff.status).toBe(429);

  const portal = await request(app).post('/api/v1/portal/auth/refresh').send({ refreshToken: 'x'.repeat(64) });
  expect(portal.status).not.toBe(429);
});
