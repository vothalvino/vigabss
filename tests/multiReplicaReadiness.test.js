// =============================================================================
// SEC-24 — Multi-replica readiness: shared IP limits and realtime fan-out
// =============================================================================
// Every per-IP limiter used express-rate-limit's in-memory store, so N
// replicas allowed N times each budget, and SSE, WebSocket and GraphQL
// subscription events reached only the clients of the process that produced
// them. With REDIS_URL set, the limiters now count in Redis and a realtime bus
// relays events between processes.
// =============================================================================

// A Redis pub/sub broker shared by every "process" in this file.
const mockBroker = { subscribers: new Set(), published: [] };

jest.mock('ioredis', () => {
  class FakeRedis {
    constructor() {
      this.listeners = {};
      this.channels = new Set();
    }

    on(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); return this; }

    async connect() {}

    duplicate() { return new FakeRedis(); }

    async subscribe(channel) {
      this.channels.add(channel);
      mockBroker.subscribers.add(this);
    }

    async publish(channel, message) {
      mockBroker.published.push({ channel, message });
      for (const sub of mockBroker.subscribers) {
        if (sub.channels.has(channel)) for (const fn of sub.listeners.message || []) fn(channel, message);
      }
      return 1;
    }

    async quit() { mockBroker.subscribers.delete(this); }

    disconnect() { mockBroker.subscribers.delete(this); }
  }
  return FakeRedis;
});

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const flush = () => new Promise(resolve => setImmediate(resolve));

/** Load a fresh copy of the modules, as a separate replica would. */
function replica() {
  let mods;
  jest.isolateModules(() => {
    mods = {
      events: require('../src/routes/events'),
      pubsub: require('../src/services/pubsub').pubsub,
      bus: require('../src/services/realtimeBus'),
    };
  });
  return mods;
}

describe('SEC-24: per-IP limiters', () => {
  const IP_LIMITERS = [
    'apiLimiter', 'sessionLimiter', 'portalSessionLimiter', 'authLimiter', 'portalAuthLimiter',
    'passwordResetLimiter', 'verifyEmailResendLimiter', 'bulkEmailLimiter', 'portalPasswordResetLimiter',
    'publicLimiter', 'uploadLimiter', 'exportLimiter', 'sseLimiter', 'webhookLimiter', 'acsLimiter',
  ];
  const FAIL_CLOSED = new Set([
    'authLimiter', 'portalAuthLimiter', 'passwordResetLimiter', 'verifyEmailResendLimiter',
    'bulkEmailLimiter', 'portalPasswordResetLimiter',
  ]);

  function limiterOptions(redisUrl) {
    const saved = process.env.REDIS_URL;
    if (redisUrl) process.env.REDIS_URL = redisUrl; else delete process.env.REDIS_URL;
    const created = [];
    let rateLimit;
    try {
      jest.isolateModules(() => {
        jest.doMock('express-rate-limit', () => {
          const fn = (options) => {
            const mw = (_req, _res, next) => next();
            mw.options = options;
            created.push(options);
            return mw;
          };
          return fn;
        });
        rateLimit = require('../src/middleware/rateLimit');
      });
    } finally {
      jest.dontMock('express-rate-limit');
      if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
    }
    return { rateLimit, created };
  }

  test('with REDIS_URL every IP limiter counts in the shared store, each under its own prefix', () => {
    const { rateLimit, created } = limiterOptions('redis://redis:6379');
    // The limiter middlewares wrap the express-rate-limit instance; find each
    // one's options through the order they were created in.
    const shared = created.filter(o => o.store instanceof rateLimit.CacheStore && o.store.prefix.startsWith('rl_ip_'));
    expect(shared).toHaveLength(IP_LIMITERS.length);
    const prefixes = shared.map(o => o.store.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);

    const closed = shared.filter(o => o.passOnStoreError === false).map(o => o.store.prefix).sort();
    expect(closed).toEqual([
      'rl_ip_auth:', 'rl_ip_bulk_email:', 'rl_ip_password_reset:', 'rl_ip_portal_auth:',
      'rl_ip_portal_password_reset:', 'rl_ip_verify_email_resend:',
    ]);
    expect(closed).toHaveLength(FAIL_CLOSED.size);
    expect(shared.filter(o => o.passOnStoreError === true)).toHaveLength(IP_LIMITERS.length - FAIL_CLOSED.size);
  });

  test('without REDIS_URL the IP limiters keep the in-memory store (one replica)', () => {
    const { created } = limiterOptions(null);
    expect(created.filter(o => o.store && o.store.prefix && o.store.prefix.startsWith('rl_ip_'))).toHaveLength(0);
  });
});

describe('SEC-24: realtime events reach every replica', () => {
  const savedUrl = process.env.REDIS_URL;
  let a;
  let b;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://redis:6379';
    mockBroker.subscribers.clear();
    mockBroker.published.length = 0;
    a = replica();
    b = replica();
  });

  afterEach(async () => {
    await a.bus.close();
    await b.bus.close();
    if (savedUrl === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = savedUrl;
  });

  test('an SSE broadcast on one replica is written to a client connected to another', async () => {
    await flush();
    const onA = { write: jest.fn() };
    const onB = { write: jest.fn() };
    a.events.getChannel('org:1:notifications').add(onA);
    b.events.getChannel('org:1:notifications').add(onB);

    a.events.broadcast('org:1:notifications', 'invoice.created', { id: 9 });
    await flush();

    const frame = 'event: invoice.created\ndata: {"id":9}\n\n';
    expect(onA.write).toHaveBeenCalledWith(frame);
    expect(onB.write).toHaveBeenCalledWith(frame);
    // Once each: the producing replica ignores its own message from Redis.
    expect(onA.write).toHaveBeenCalledTimes(1);
    expect(onB.write).toHaveBeenCalledTimes(1);
  });

  test('a GraphQL publish on one replica reaches a subscription on another', async () => {
    await flush();
    const iterator = b.pubsub.subscribe('TICKET_COMMENT_ADDED')[Symbol.asyncIterator]();
    const next = iterator.next();
    await flush();

    a.pubsub.publish('TICKET_COMMENT_ADDED', { ticketId: '5', orgId: 1, ticketCommentAdded: { id: 77 } });

    await expect(next).resolves.toEqual({
      done: false,
      value: { ticketId: '5', orgId: 1, ticketCommentAdded: { id: 77 } },
    });
    await iterator.return();
  });

  test('without REDIS_URL events stay on the producing process and no Redis client is made', async () => {
    await a.bus.close();
    await b.bus.close();
    delete process.env.REDIS_URL;
    mockBroker.subscribers.clear();
    const solo = replica();
    const client = { write: jest.fn() };
    solo.events.getChannel('org:2:notifications').add(client);

    solo.events.broadcast('org:2:notifications', 'x', { ok: true });
    await flush();

    expect(client.write).toHaveBeenCalledTimes(1);
    expect(mockBroker.published).toHaveLength(0);
    expect(mockBroker.subscribers.size).toBe(0);
  });
});
