// =============================================================================
// NET-21 — router management targets cannot point into the platform's network
// =============================================================================
// A NAS's management address accepted any string, including hostnames, and
// test-connection / seed opened a TCP connection to it and returned the raw
// socket error. A devices.update user could point a NAS at 127.0.0.1, the
// database, Redis or 169.254.169.254 and use the routes as a port scanner and
// DNS oracle. Routers live on private space, so RFC 1918 and CGNAT stay legal.
// =============================================================================

const { managementTargetProblem, assertManagementTarget } = require('../src/utils/managementTarget');
const ros = require('../src/services/routerosService');

afterEach(() => {
  delete process.env.MANAGEMENT_TARGET_DENY_CIDRS;
  delete process.env.MANAGEMENT_TARGET_ALLOW_CIDRS;
});

test.each([
  '10.20.30.1', '192.168.88.1', '172.16.5.1', '100.64.0.10', '203.0.113.9', '2806:2f0::1',
])('a router address %s is allowed', (ip) => {
  expect(managementTargetProblem(ip)).toBeNull();
});

test.each([
  ['127.0.0.1', /loopback/],
  ['127.5.5.5', /loopback/],
  ['0.0.0.0', /reserved/],
  ['169.254.169.254', /link-local/],
  ['224.0.0.5', /multicast/],
  ['255.255.255.255', /reserved/],
  ['::1', /loopback/],
  ['::', /unspecified/],
  ['fe80::1', /link-local/],
  ['::ffff:127.0.0.1', /loopback/],
  ['db', /hostname/],
  ['redis.internal', /hostname/],
  ['metadata.google.internal', /hostname/],
])('%s is refused', (ip, why) => {
  expect(managementTargetProblem(ip)).toMatch(why);
});

test('the install operator can reserve the app network and admit a lab range', () => {
  process.env.MANAGEMENT_TARGET_DENY_CIDRS = '172.18.0.0/16, 10.99.0.0/24';
  expect(managementTargetProblem('172.18.0.4')).toMatch(/reserves/);
  expect(managementTargetProblem('10.99.0.7')).toMatch(/reserves/);
  expect(managementTargetProblem('10.98.0.7')).toBeNull();
  process.env.MANAGEMENT_TARGET_ALLOW_CIDRS = '127.0.0.1/32';
  expect(managementTargetProblem('127.0.0.1')).toBeNull();
});

test('assertManagementTarget answers 422 with the field', () => {
  expect(() => assertManagementTarget('127.0.0.1')).toThrow(expect.objectContaining({ statusCode: 422 }));
});

test('every RouterOS connection is checked before a socket opens', async () => {
  const net = require('net');
  const spy = jest.spyOn(net, 'createConnection');
  await expect(ros.createClient({ host: '127.0.0.1', port: 6379, user: 'x', password: 'y' }))
    .rejects.toMatchObject({ statusCode: 422 });
  await expect(ros.createClient({ host: 'db', port: 3306, user: 'x', password: 'y' }))
    .rejects.toMatchObject({ statusCode: 422 });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

describe('the NAS routes', () => {
  const request = require('supertest');
  jest.doMock('../src/middleware/auth', () => ({
    authenticate: (req, _res, next) => { req.user = { id: 8, role: 'admin' }; next(); },
  }));
  jest.doMock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
  jest.doMock('../src/middleware/rbac', () => ({
    userHasPermission: async () => true,
    requirePermission: () => (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
  }));

  test.each([
    ['post', '/api/v1/nas', { name: 'n', ip_address: '127.0.0.1', secret: 's' }],
    ['post', '/api/v1/nas', { name: 'n', ip_address: 'redis', secret: 's' }],
    ['put', '/api/v1/nas/1', { ip_address: '169.254.169.254' }],
  ])('%s %s refuses a platform-internal address', async (method, path, body) => {
    const app = require('../src/app');
    const res = await request(app)[method](path).send(body);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/ip_address/);
  });
});
