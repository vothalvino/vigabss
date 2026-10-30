// =============================================================================
// VigaBSS 5.0 — FireRelay install-operator boundary (TNA-01)
// =============================================================================
// The FireRelay node registry (firerelay_nodes has no organization_id) and the
// tunnel agents are installation-wide: an agent fronts POP routers regardless
// of which tenant owns them, and /tunnel/command relays RouterOS operations to
// it. A tenant admin/owner role must therefore NOT be enough — only the
// verified install operator may list agents, manage nodes, or send commands,
// and API tokens never inherit that authority. /tunnel/command additionally
// accepts only the methods an agent actually implements.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const { tunnelServer } = require('../src/services/firerelayTunnel');
const { handlers } = require('../src/services/routerosService');
const { firerelayTunnelCommand } = require('../src/middleware/schemas/firerelay');
const app = require('../src/app');

function tokenFor(role) {
  return jwt.sign({ sub: 2, email: 'user@test.com', role, orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
}

function mockAuth({ role = 'admin', installOperator = false } = {}) {
  db.query.mockImplementation((sql) => {
    if (typeof sql !== 'string') return Promise.resolve([[]]);
    if (sql.includes('WHERE id = ?')) {
      return Promise.resolve([[{
        id: 2,
        email: 'user@test.com',
        role,
        status: 'active',
        organization_id: 1,
        is_install_operator: installOperator ? 1 : 0,
      }]]);
    }
    return Promise.resolve([[]]);
  });
}

let sendCommandSpy;
let isConnectedSpy;
let connectedAgentsSpy;

beforeEach(() => {
  jest.clearAllMocks();
  sendCommandSpy = jest.spyOn(tunnelServer, 'sendCommand').mockResolvedValue({ ok: true });
  isConnectedSpy = jest.spyOn(tunnelServer, 'isConnected').mockReturnValue(true);
  connectedAgentsSpy = jest.spyOn(tunnelServer, 'connectedAgents').mockReturnValue(['pop-a', 'pop-b']);
});

afterEach(() => {
  sendCommandSpy.mockRestore();
  isConnectedSpy.mockRestore();
  connectedAgentsSpy.mockRestore();
});

describe('FireRelay routes — tenant admin is not the install operator', () => {
  it('refuses GET /tunnel/agents to an ordinary tenant admin', async () => {
    mockAuth({ role: 'admin' });
    const res = await request(app)
      .get('/api/v1/firerelay/tunnel/agents')
      .set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
    expect(connectedAgentsSpy).not.toHaveBeenCalled();
  });

  it('refuses POST /tunnel/command to an ordinary tenant admin and never relays it', async () => {
    mockAuth({ role: 'admin' });
    const res = await request(app)
      .post('/api/v1/firerelay/tunnel/command')
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({
        node_id: 'pop-b',
        method: 'pppoe.delete',
        params: { host: '10.0.0.1', user: 'admin', password: 'x', name: 'victim' },
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
    expect(sendCommandSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/api/v1/firerelay/nodes'],
    ['post', '/api/v1/firerelay/nodes'],
    ['put', '/api/v1/firerelay/nodes/node2'],
    ['delete', '/api/v1/firerelay/nodes/node2'],
  ])('refuses %s %s to an ordinary tenant admin', async (method, path) => {
    mockAuth({ role: 'admin' });
    const res = await request(app)[method](path)
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({ id: 'node2', api_url: 'https://node2.example.test', status: 'active' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSTALL_OPERATOR_ONLY');
  });
});

describe('FireRelay routes — the install operator', () => {
  it('can list connected agents', async () => {
    mockAuth({ role: 'admin', installOperator: true });
    const res = await request(app)
      .get('/api/v1/firerelay/tunnel/agents')
      .set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(['pop-a', 'pop-b']);
  });

  it('can send an implemented command', async () => {
    mockAuth({ role: 'admin', installOperator: true });
    const res = await request(app)
      .post('/api/v1/firerelay/tunnel/command')
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({ node_id: 'pop-a', method: 'wireguard.readTopology', params: {} });
    expect(res.status).toBe(200);
    expect(sendCommandSpy).toHaveBeenCalledWith('pop-a', 'wireguard.readTopology', {}, undefined);
  });

  it('cannot relay a method no agent implements', async () => {
    mockAuth({ role: 'admin', installOperator: true });
    const res = await request(app)
      .post('/api/v1/firerelay/tunnel/command')
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({ node_id: 'pop-a', method: 'system.shell', params: {} });
    expect(res.status).toBe(422);
    expect(sendCommandSpy).not.toHaveBeenCalled();
  });
});

describe('FireRelay tunnel method allowlist', () => {
  it('matches exactly the handlers a FireRelay agent implements', () => {
    expect([...firerelayTunnelCommand.method.enum].sort()).toEqual(Object.keys(handlers).sort());
  });
});
