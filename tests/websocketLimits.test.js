// =============================================================================
// SEC-16 — WebSocket frame size and pre-auth connection limits
// =============================================================================
// Both servers used ws's 100 MiB maxPayload default and JSON-parsed the first
// message of an unauthenticated socket in full; nothing capped how many
// sockets could wait unauthenticated.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/config/firerelay', () => ({
  mode: 'master', nodes: [], healthInterval: 30000, requestTimeout: 5000, maxRetries: 2,
  masterUrl: '', nodeId: '', autoIncrementOffset: 1, maxClients: 10000, maxDevices: 3000,
  tunnelSecret: 'test-secret', tunnelAuthTimeout: 10000, tunnelCommandTimeout: 2000, tunnelPingInterval: 60000,
}));

const http = require('http');
const WebSocket = require('ws');
const { WsHub, BROWSER_WS_PATH } = require('../src/services/wsHub');
const { TunnelServer } = require('../src/services/firerelayTunnel');
const { PendingSockets } = require('../src/services/wsLimits');

async function serve(make) {
  const server = http.createServer();
  const svc = make();
  svc.attach(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, svc, port: server.address().port };
}
const closeCode = ws => new Promise((resolve) => ws.once('close', code => resolve(code)));
const opened = ws => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

describe.each([
  ['browser hub', () => new WsHub(), BROWSER_WS_PATH],
  ['FireRelay tunnel', () => new TunnelServer(), '/ws/firerelay'],
])('%s', (_name, make, path) => {
  let ctx;
  beforeEach(async () => { ctx = await serve(make); });
  afterEach(async () => {
    ctx.svc.close?.();
    await new Promise(r => ctx.server.close(r));
  });

  test('a large message before authentication closes the socket unparsed (1009)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${path}`);
    await opened(ws);
    const code = closeCode(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'x'.repeat(64 * 1024) }));
    expect(await code).toBe(1009);
  });

  test('a frame over maxPayload is refused by the server (1009)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}${path}`);
    await opened(ws);
    const code = closeCode(ws);
    ws.send(Buffer.alloc(9 * 1024 * 1024, 0x61));
    expect(await code).toBe(1009);
  });
});

test('PendingSockets caps unauthenticated sockets per IP and in total, and release frees a slot', () => {
  const pending = new PendingSockets({ perIp: 2, total: 3 });
  const a = pending.admit('10.0.0.1');
  const b = pending.admit('10.0.0.1');
  expect(a && b).toBeTruthy();
  expect(pending.admit('10.0.0.1')).toBeNull();
  expect(pending.admit('10.0.0.2')).toBeTruthy();
  expect(pending.admit('10.0.0.3')).toBeNull();
  a(); a();
  expect(pending.admit('10.0.0.1')).toBeTruthy();
});

test('the hub refuses a connection once the IP has too many pending sockets (1013)', async () => {
  const ctx = await serve(() => new WsHub());
  ctx.svc._pendingSockets = new PendingSockets({ perIp: 1, total: 10 });
  const first = new WebSocket(`ws://127.0.0.1:${ctx.port}${BROWSER_WS_PATH}`);
  await opened(first);
  const second = new WebSocket(`ws://127.0.0.1:${ctx.port}${BROWSER_WS_PATH}`);
  expect(await closeCode(second)).toBe(1013);
  first.terminate();
  ctx.svc.close?.();
  await new Promise(r => ctx.server.close(r));
});
