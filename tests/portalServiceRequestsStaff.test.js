// =============================================================================
// TNB-15 / TNB-11 — staff can process subscriber service requests, safely
// =============================================================================
// TNB-15: /api/v1/portal-service-requests mounted authenticate but not
// orgScope, so req.orgId was undefined, mysql2 threw on the undefined bind,
// and every endpoint returned 500; subscriber requests stayed pending.
// TNB-11: a plan-upgrade request could name an inactive plan, approval applied
// the stored plan id without checking it again or scoping the contract
// update, and two approvals could both run the action.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const service = require('../src/services/portalServiceRequestService');
const app = require('../src/app');

const token = jwt.sign({ sub: 1, email: 'a@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const call = (method, path, body) => request(app)[method](`/api/v1/portal-service-requests${path}`)
  .set('Authorization', `Bearer ${token}`).send(body);

// mysql2 refuses undefined bind values; so does this mock.
function strictDb(answer) {
  db.query.mockImplementation(async (sql, params = []) => {
    if (params.some(v => v === undefined)) throw new TypeError('Bind parameters must not contain undefined');
    return answer(sql, params);
  });
}
const PENDING = { id: 7, organization_id: 1, client_id: 5, contract_id: 8, status: 'pending', request_type: 'static_ip_request', payload: '{}' };

beforeEach(() => {
  jest.restoreAllMocks();
  db.query.mockReset();
  User.findById.mockResolvedValue({ id: 1, email: 'a@test.com', status: 'active', role: 'admin', organization_id: 1 });
});

describe('staff endpoints run in the caller organization', () => {
  const answer = (sql) => {
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 1 }]];
    if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: 1 }];
    return [[{ ...PENDING }]];
  };

  test.each([
    ['get', '', 200],
    ['get', '/7', 200],
    ['get', '/push-subscriptions', 200],
    ['post', '/7/approve', 200],
    ['post', '/7/reject', 200],
  ])('%s %s answers %i and binds organization 1', async (method, path, status) => {
    strictDb(answer);
    const res = await call(method, path, method === 'post' ? { notes: 'ok' } : undefined);
    expect(res.status).toBe(status);
    expect(db.query.mock.calls.some(([sql, params = []]) => /portal_(service_requests|push_subscriptions)/.test(sql) && params.includes(1))).toBe(true);
  });

  test('complete marks an approved request done', async () => {
    strictDb((sql) => (/^\s*UPDATE/.test(sql) ? [{ affectedRows: 1 }] : [[{ ...PENDING, status: 'approved' }]]));
    const res = await call('post', '/7/complete', {});
    expect(res.status).toBe(200);
  });
});

describe('plan upgrades', () => {
  test('a subscriber cannot request an inactive or foreign plan', async () => {
    strictDb((sql) => {
      if (/FROM contracts c/.test(sql)) return [[{ id: 8, plan_id: 2, price: '399.00', plan_name: 'Basic' }]];
      if (/FROM plans/.test(sql)) {
        expect(sql).toMatch(/status = 'active'/);
        expect(sql).toMatch(/organization_id <=> \? OR organization_id IS NULL/);
        return [[]];
      }
      return [[]];
    });
    await expect(service.createRequest({ clientId: 5, organizationId: 1, requestType: 'plan_upgrade', payload: { new_plan_id: 99 } }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('approval re-checks the plan and leaves the request pending when it is gone', async () => {
    strictDb((sql) => {
      if (/FROM portal_service_requests WHERE id/.test(sql)) return [[{ ...PENDING, request_type: 'plan_upgrade', payload: '{"new_plan_id":99}' }]];
      if (/FROM plans/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    });
    await expect(service.approveRequest(7, 1, 2, null)).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls.some(([sql]) => /^\s*UPDATE/.test(sql))).toBe(false);
  });

  test('a second, concurrent approval does not run the action again', async () => {
    strictDb((sql) => {
      if (/FROM portal_service_requests WHERE id/.test(sql)) return [[{ ...PENDING, request_type: 'plan_upgrade', payload: '{"new_plan_id":3}' }]];
      if (/FROM plans/.test(sql)) return [[{ id: 3 }]];
      if (/SET status = 'approved'/.test(sql)) return [{ affectedRows: 0 }]; // the other approval won
      return [{ affectedRows: 1 }];
    });
    await expect(service.approveRequest(7, 1, 2, null)).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls.some(([sql]) => /UPDATE contracts/.test(sql))).toBe(false);
  });
});

describe('requested passwords', () => {
  test.each([
    ['pppoe_password_change', 'short'],
    ['pppoe_password_change', 'has a space'],
    ['wifi_password_change', 'x'.repeat(64)],
    ['wifi_password_change', 'contraseña1'],
    ['wifi_password_change', undefined],
  ])('%s with %j is refused', async (requestType, password) => {
    strictDb(() => [[{ id: 8, plan_id: 2 }]]);
    await expect(service.createRequest({ clientId: 5, organizationId: 1, requestType, payload: { new_password: password } }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO portal_service_requests/.test(sql))).toBe(false);
  });
});
