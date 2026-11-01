// =============================================================================
// NET-20 — the embedded RADIUS server bounds its ingress and can require MA
// =============================================================================
// Every datagram started an unbounded async handler, and one from a registered
// NAS's IP cost a secret fetch, a subscriber query and a radpostauth INSERT.
// Access-Requests without Message-Authenticator cannot be authenticated, so a
// spoofed-source flood from a known NAS address was processed in full, while
// production compose enabled the server on every interface.
// =============================================================================

const crypto = require('crypto');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/radiusAccountingService', () => ({ ingestAccounting: jest.fn() }));

const db = require('../src/config/database');
const codec = require('../src/services/radiusServerCodec');
const coa = require('../src/services/radiusCoaEncoder');

const SECRET = 'testing123';

function load(env = {}) {
  let svc;
  jest.isolateModules(() => {
    Object.assign(process.env, env);
    svc = require('../src/services/radiusServerService');
  });
  for (const k of Object.keys(env)) delete process.env[k];
  return svc;
}

function accessRequest({ withMessageAuth = false } = {}) {
  const reqAuth = crypto.randomBytes(16);
  const parts = [coa.encodeAttributes([coa.encodeUserName('bob')])];
  if (withMessageAuth) parts.push(codec.messageAuthenticatorPlaceholder());
  const pkt = coa.buildRadiusPacket(codec.CODE.ACCESS_REQUEST, 7, reqAuth, Buffer.concat(parts));
  if (withMessageAuth) {
    // Sign the request's Message-Authenticator: HMAC-MD5 over the packet with it zeroed.
    const off = pkt.indexOf(Buffer.from([80, 18]), 20);
    const mac = crypto.createHmac('md5', Buffer.from(SECRET)).update(pkt).digest();
    mac.copy(pkt, off + 2);
  }
  return pkt;
}

beforeEach(() => jest.clearAllMocks());

describe('ingress bounds', () => {
  test('a source over its rate is dropped and counted', async () => {
    const svc = load({ RADIUS_SERVER_SOURCE_RATE: '1', RADIUS_SERVER_SOURCE_BURST: '3' });
    const handler = jest.fn().mockResolvedValue(undefined);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(svc.admit(Buffer.alloc(0), { address: '10.0.0.1' }, jest.fn(), handler, 'auth'));
    await Promise.all(results.filter(Boolean));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(svc.getStatus().counters.droppedSourceRate).toBe(2);
    // Another source has its own budget.
    expect(svc.admit(Buffer.alloc(0), { address: '10.0.0.2' }, jest.fn(), handler, 'auth')).not.toBeNull();
  });

  test('past the in-flight cap new requests are dropped', async () => {
    const svc = load({ RADIUS_SERVER_MAX_IN_FLIGHT: '2' });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = jest.fn(() => gate);
    const a = svc.admit(Buffer.alloc(0), { address: '10.0.0.1' }, jest.fn(), slow, 'auth');
    const b = svc.admit(Buffer.alloc(0), { address: '10.0.0.2' }, jest.fn(), slow, 'auth');
    const c = svc.admit(Buffer.alloc(0), { address: '10.0.0.3' }, jest.fn(), slow, 'auth');
    expect(c).toBeNull();
    expect(svc.getStatus()).toMatchObject({ inFlight: 2, counters: expect.objectContaining({ droppedOverload: 1 }) });
    release();
    await Promise.all([a, b]);
    expect(svc.getStatus().inFlight).toBe(0);
  });
});

describe('Message-Authenticator', () => {
  const nasRow = (requireMa) => ({ id: 3, organization_id: 1, secret: SECRET, require_message_authenticator: requireMa });

  function wire(requireMa) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM nas/.test(sql)) return [[nasRow(requireMa)]];
      return [[]];
    });
  }

  test('a NAS that requires it gets its unsigned requests dropped', async () => {
    const svc = load();
    wire(1);
    const respond = jest.fn();
    await svc.handleAuth(accessRequest(), { address: '10.0.0.1', port: 5000 }, respond);
    expect(respond).not.toHaveBeenCalled();
    expect(svc.getStatus().counters.droppedNoMessageAuth).toBe(1);
  });

  test('a signed request from that NAS is answered', async () => {
    const svc = load();
    wire(1);
    const respond = jest.fn();
    await svc.handleAuth(accessRequest({ withMessageAuth: true }), { address: '10.0.0.1', port: 5000 }, respond);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  test('replies carry Message-Authenticator first, even to an unsigned request', async () => {
    const svc = load();
    wire(0);
    const respond = jest.fn();
    await svc.handleAuth(accessRequest(), { address: '10.0.0.1', port: 5000 }, respond);
    const reply = respond.mock.calls[0][0];
    expect(reply[0]).toBe(codec.CODE.ACCESS_REJECT);
    expect(reply[20]).toBe(80); // first attribute
    expect(reply[21]).toBe(18);
    const decoded = codec.decodePacket(reply);
    expect(codec.getAttr(decoded.attributes, codec.ATTR.MESSAGE_AUTHENTICATOR)).toHaveLength(16);
  });
});
