// =============================================================================
// VigaBSS 5.0 — DR Drill Routes Tests
// =============================================================================
// GET /dr-drill/runbook serves docs/dr-drill.md (the in-app runbook the
// DrDrillBanner modal links to — its old /docs/dr-drill.md href 404'd because
// nothing serves repo files).

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../src/models/User');

jest.mock('../src/utils/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const User = require('../src/models/User');
const app = require('../src/app');

function makeToken(payload = {}) {
  return jwt.sign(
    { sub: 1, email: 'test@example.com', role: 'admin', orgId: 1, ...payload },
    config.jwt.secret,
    { expiresIn: '1h' },
  );
}

function mockAuthUser(overrides = {}) {
  User.findById.mockResolvedValue({
    id: 1, email: 'test@example.com', status: 'active', role: 'admin', organization_id: 1,
    is_install_operator: 1, ...overrides,
  });
  // installOperator reads the flag from users when req.user does not carry it.
  const flag = overrides.is_install_operator ?? 1;
  require('../src/config/database').query.mockImplementation(async (sql) => (
    /is_install_operator/.test(sql) ? [[{ is_install_operator: flag }]] : [[]]
  ));
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('GET /api/v1/dr-drill/runbook', () => {
  test('requires authentication', async () => {
    const res = await request(app).get('/api/v1/dr-drill/runbook');
    expect(res.status).toBe(401);
  });

  test('returns the runbook markdown from docs/dr-drill.md', async () => {
    mockAuthUser();
    const res = await request(app)
      .get('/api/v1/dr-drill/runbook')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('X-Org-Id', '1');

    expect(res.status).toBe(200);
    expect(typeof res.body.data.markdown).toBe('string');
    // Content of the real repo doc — this test reads the actual file, so it
    // also guards against the doc being moved without updating the route.
    expect(res.body.data.markdown).toContain('Disaster-Recovery Drill');
    expect(res.body.data.markdown).toContain('Quarterly Drill Log');
  });
});

// RTE-09: the drill log is install-wide (backups, restore timings, last_error),
// so an organization's own admin must not read it through settings.view.
describe('DR drill routes are install-operator only', () => {
  const drDrillService = require('../src/services/drDrillService');

  test.each(['/api/v1/dr-drill/status', '/api/v1/dr-drill/runbook'])(
    'a tenant admin who is not the install operator gets 403 from %s', async (path) => {
      mockAuthUser({ id: 7, organization_id: 2, is_install_operator: 0 });
      const spy = jest.spyOn(drDrillService, 'getDrillStatus');
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${makeToken({ sub: 7, orgId: 2 })}`)
        .set('X-Org-Id', '2');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
      expect(JSON.stringify(res.body)).not.toMatch(/last_error/);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

  test('the install operator still gets the status', async () => {
    mockAuthUser();
    const spy = jest.spyOn(drDrillService, 'getDrillStatus')
      .mockResolvedValue({ overdue: false, last_error: null });
    const res = await request(app)
      .get('/api/v1/dr-drill/status')
      .set('Authorization', `Bearer ${makeToken()}`)
      .set('X-Org-Id', '1');

    expect(res.status).toBe(200);
    expect(res.body.data.overdue).toBe(false);
    spy.mockRestore();
  });
});
