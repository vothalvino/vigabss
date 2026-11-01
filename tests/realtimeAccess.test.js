// =============================================================================
// SEC-09 — real-time channels apply RBAC, scopes and revocation
// =============================================================================
// /events/* and the browser WebSocket hub checked only authentication and the
// organization: every persona got invoice totals, payment amounts and ticket
// subjects, any ticket id could be followed, /events/stats listed every
// tenant's channels, and the hub never looked the account up.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const app = require('../src/app');
const events = require('../src/routes/events');
const realtimeAccess = require('../src/services/realtimeAccess');

const token = jwt.sign({ sub: 3, email: 't@test.com', role: 'technician', orgId: 1, tv: 0 }, config.jwt.secret, { expiresIn: '1h' });
const get = (path) => request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1');

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue([[]]);
  User.findById.mockResolvedValue({ id: 3, email: 't@test.com', status: 'active', role: 'technician', organization_id: 1, token_version: 0 });
  User.getPermissions.mockResolvedValue(['tickets.view']);
});

describe('SSE channels', () => {
  test.each(['/events/metrics', '/events/outages'])('%s needs its REST slug (403)', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(403);
  });

  test('a ticket stream needs a ticket of this organization (404)', async () => {
    const res = await get('/events/tickets/900');
    expect(res.status).toBe(404);
    const [sql, params] = db.query.mock.calls.find(([s]) => /FROM tickets WHERE id = \?/.test(s));
    expect(sql).toMatch(/organization_id = \?/);
    expect(params).toEqual([900, 1]);
  });

  test('a billing ticket stream needs tickets.view_billing (404)', async () => {
    db.query.mockImplementation(async (sql) => (/FROM tickets WHERE id/.test(sql) ? [[{ id: 12, category: 'billing' }]] : [[]]));
    const res = await get('/events/tickets/12');
    expect(res.status).toBe(404);
  });

  test('/events/stats lists only the caller\'s organization', async () => {
    events.getChannel('org:1:notifications').add({});
    events.getChannel('org:2:ticket:55').add({});
    const res = await get('/events/stats');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.channels)).toEqual(['org:1:notifications']);
    events.channels.clear();
  });
});

describe('notification feed filtering', () => {
  function subscriber(grants) {
    const res = { written: [], write(m) { this.written.push(m); }, _grants: new Set(grants) };
    events.getChannel('org:1:notifications').add(res);
    return res;
  }
  afterEach(() => events.channels.clear());

  test('each event reaches only subscribers holding its slug', () => {
    const tech = subscriber(['tickets.view']);
    const billing = subscriber(['tickets.view', 'invoices.view', 'payments.view']);
    events.broadcast('org:1:notifications', 'invoice.created', { invoice_number: 'F-1', total: 900 });
    events.broadcast('org:1:notifications', 'payment.received', { amount: 900 });
    events.broadcast('org:1:notifications', 'ticket.created', { id: 1, subject: 'No signal', category: 'support' });
    expect(tech.written.join('')).not.toMatch(/invoice\.created|payment\.received/);
    expect(tech.written.join('')).toMatch(/ticket\.created/);
    expect(billing.written).toHaveLength(3);
  });

  test('a billing ticket event needs tickets.view_billing; unknown events go nowhere', () => {
    const tech = subscriber(['tickets.view']);
    events.broadcast('org:1:notifications', 'ticket.created', { id: 2, subject: 'Refund', category: 'billing' });
    events.broadcast('org:1:notifications', 'something.new', { secret: 1 });
    expect(tech.written).toHaveLength(0);
  });
});

describe('long-lived subscriptions are re-checked', () => {
  test.each([
    ['an inactive user', [[{ status: 'inactive', token_version: 0 }]], { userId: 3, tokenVersion: 0 }],
    ['a revoked token version', [[{ status: 'active', token_version: 2 }]], { userId: 3, tokenVersion: 1 }],
    ['an archived user', [[]], { userId: 3, tokenVersion: 0 }],
  ])('%s loses the stream', async (_l, rows, principal) => {
    db.query.mockResolvedValueOnce(rows);
    expect(await realtimeAccess.stillAuthorized(principal)).toBe(false);
  });

  test('a revoked API token loses the stream', async () => {
    db.query.mockResolvedValueOnce([[]]);
    expect(await realtimeAccess.stillAuthorized({ userId: 3, apiTokenId: 8 })).toBe(false);
  });
});

describe('browser WebSocket hub', () => {
  const http = require('http');
  const WebSocket = require('ws');
  const { WsHub, BROWSER_WS_PATH } = require('../src/services/wsHub');
  let server; let hub; let port;
  beforeEach(async () => {
    server = http.createServer();
    hub = new WsHub();
    hub.attach(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterEach(async () => { hub.close?.(); await new Promise(r => server.close(r)); });

  const next = (ws, pred) => new Promise((resolve) => {
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (pred(m)) resolve(m); });
  });
  async function connect(tv = 0) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_WS_PATH}`);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const reply = next(ws, m => m.type === 'auth_ok' || m.type === 'auth_fail');
    ws.send(JSON.stringify({ type: 'auth', token: jwt.sign({ sub: 3, orgId: 1, tv }, config.jwt.secret, { expiresIn: '1h' }) }));
    return { ws, reply: await reply };
  }

  test.each([
    ['an inactive account', { status: 'inactive', token_version: 0 }, 0],
    ['a stale token version', { status: 'active', token_version: 1 }, 0],
  ])('%s is refused at auth', async (_l, user, tv) => {
    User.findById.mockResolvedValue({ id: 3, role: 'technician', organization_id: 1, ...user });
    const { ws, reply } = await connect(tv);
    expect(reply.type).toBe('auth_fail');
    ws.terminate();
  });

  test('a channel needs its slug, and the feed is filtered per subscriber', async () => {
    const { ws, reply } = await connect();
    expect(reply.type).toBe('auth_ok');
    const refused = next(ws, m => m.type === 'error');
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'metrics' }));
    expect((await refused).reason).toMatch(/Not permitted/);

    const subscribed = next(ws, m => m.type === 'subscribed');
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'notifications' }));
    await subscribed;
    const got = [];
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'event') got.push(m.event); });
    hub.broadcastWs('org:1:notifications', 'invoice.created', { total: 900 });
    hub.broadcastWs('org:1:notifications', 'ticket.created', { id: 1, category: 'support' });
    await new Promise(r => setTimeout(r, 100));
    expect(got).toEqual(['ticket.created']);
    ws.terminate();
  });
});
