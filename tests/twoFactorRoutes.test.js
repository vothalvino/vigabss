// =============================================================================
// VigaBSS — SEC-03: /2fa route hardening
// =============================================================================
// - API tokens can never read, replace, validate or disable a person's second
//   factor (any API key used to be able to strip 2FA via POST /2fa/setup).
// - POST /2fa/setup forwards the re-verification fields to the service, which
//   refuses to replace an enabled secret without them.
// =============================================================================

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 5, email: 'u@example.com', role: 'technician', organizationId: 1 };
    if (req.headers['x-test-api-token']) req.user.apiTokenId = 77;
    next();
  },
}));

jest.mock('../src/services/twoFactorService', () => ({
  getStatus: jest.fn().mockResolvedValue({ enabled: true }),
  generateSecret: jest.fn(),
  verifyAndEnable: jest.fn(),
  verifyCode: jest.fn(),
  disable: jest.fn(),
  regenerateBackupCodes: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const twoFactorRoutes = require('../src/routes/twoFactor');
const twoFactorService = require('../src/services/twoFactorService');
const { ForbiddenError } = require('../src/utils/errors');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/2fa', twoFactorRoutes);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: { message: err.message } });
  });
  return app;
}

describe('SEC-03 — /2fa routes', () => {
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test.each([
    ['get', '/status'],
    ['post', '/setup'],
    ['post', '/verify'],
    ['post', '/validate'],
    ['post', '/disable'],
    ['post', '/backup-codes'],
  ])('API tokens are refused on %s %s', async (method, path) => {
    const res = await request(app)[method](`/api/v1/2fa${path}`)
      .set('x-test-api-token', '1')
      .send({ code: '123456' });

    expect(res.status).toBe(403);
    expect(twoFactorService.generateSecret).not.toHaveBeenCalled();
    expect(twoFactorService.disable).not.toHaveBeenCalled();
    expect(twoFactorService.verifyCode).not.toHaveBeenCalled();
    expect(twoFactorService.getStatus).not.toHaveBeenCalled();
  });

  test('POST /setup passes the re-verification code/password to the service', async () => {
    twoFactorService.generateSecret.mockResolvedValueOnce({ secret: 'S', uri: 'otpauth://x', qr_data: 'otpauth://x' });

    const res = await request(app).post('/api/v1/2fa/setup').send({ password: 'pw' });

    expect(res.status).toBe(200);
    expect(twoFactorService.generateSecret).toHaveBeenCalledWith(5, { code: undefined, password: 'pw' });
  });

  test('POST /setup surfaces the service refusal for an enabled 2FA', async () => {
    twoFactorService.generateSecret.mockRejectedValueOnce(new ForbiddenError('Two-factor authentication is already enabled.'));

    const res = await request(app).post('/api/v1/2fa/setup').send({});

    expect(res.status).toBe(403);
    expect(twoFactorService.disable).not.toHaveBeenCalled();
  });
});
