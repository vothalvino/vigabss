// =============================================================================
// SEC-28 — the portal refresh token is an httpOnly cookie, not localStorage
// =============================================================================
// The portal SPA stored its 7-day refresh token in localStorage and the API
// returned it in JSON, so any script on the page could read it.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), withTenantContext: (_id, fn) => fn() }));
jest.mock('../src/services/portalAuthService', () => ({
  login: jest.fn(),
  refreshToken: jest.fn(),
  logout: jest.fn(),
  REFRESH_SECONDS: 604800,
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const portalAuthService = require('../src/services/portalAuthService');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/portal', require('../src/routes/portal'));
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: { message: err.message } }));

const cookieNamed = (res, name) => (res.headers['set-cookie'] || []).find(c => c.startsWith(`${name}=`));

beforeEach(() => jest.clearAllMocks());

test('a browser login sets the refresh cookie and leaves it out of the JSON', async () => {
  portalAuthService.login.mockResolvedValueOnce({
    accessToken: 'pa', refreshToken: 'pr', expiresIn: 900, client: { id: 3 },
  });

  const res = await request(app).post('/api/v1/portal/auth/login')
    .set('Sec-Fetch-Site', 'same-origin')
    .send({ email: 'c@example.com', password: 'secret1234' });

  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ accessToken: 'pa', expiresIn: 900, client: { id: 3 } });
  const cookie = cookieNamed(res, 'fireisp_portal_refresh');
  expect(cookie).toMatch(/^fireisp_portal_refresh=pr;/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  expect(cookie).toMatch(/Path=\/api\/v1\/portal\/auth/);
});

test('refresh reads the cookie, rotates it and returns only the access token', async () => {
  portalAuthService.refreshToken.mockResolvedValueOnce({ accessToken: 'pa2', refreshToken: 'pr2' });

  const res = await request(app).post('/api/v1/portal/auth/refresh')
    .set('Cookie', 'fireisp_portal_refresh=pr').send({});

  expect(res.status).toBe(200);
  expect(portalAuthService.refreshToken).toHaveBeenCalledWith('pr');
  expect(res.body.data).toEqual({ accessToken: 'pa2' });
  expect(cookieNamed(res, 'fireisp_portal_refresh')).toMatch(/^fireisp_portal_refresh=pr2;/);
});

test('an API client can still refresh with the token in the body', async () => {
  portalAuthService.refreshToken.mockResolvedValueOnce({ accessToken: 'pa2', refreshToken: 'pr2' });

  const res = await request(app).post('/api/v1/portal/auth/refresh').send({ refreshToken: 'pr' });

  expect(res.body.data).toEqual({ accessToken: 'pa2', refreshToken: 'pr2' });
});

test('refresh without any token is 401', async () => {
  const res = await request(app).post('/api/v1/portal/auth/refresh').send({});
  expect(res.status).toBe(401);
  expect(portalAuthService.refreshToken).not.toHaveBeenCalled();
});

test('logout revokes the cookie token and clears the cookie', async () => {
  const res = await request(app).post('/api/v1/portal/auth/logout')
    .set('Cookie', 'fireisp_portal_refresh=pr').send({});

  expect(res.status).toBe(200);
  expect(portalAuthService.logout).toHaveBeenCalledWith('pr');
  expect(cookieNamed(res, 'fireisp_portal_refresh')).toMatch(/^fireisp_portal_refresh=;.*Expires=Thu, 01 Jan 1970/);
});
