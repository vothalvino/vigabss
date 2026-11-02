// =============================================================================
// SEC-27 — TRUST_PROXY accepts only a small hop count
// =============================================================================
// parseInt turned '10.0.0.1' into 10 and '172.16.0.0/12' into 172; Express
// then trusted that many X-Forwarded-For hops, so a client could pick its own
// address for rate limits, the admin IP allowlist and audit logs.
// =============================================================================
'use strict';

const config = require('../src/config');

test.each([['0', 0], ['1', 1], [' 2 ', 2], ['5', 5]])('%p is a hop count', (raw, hops) => {
  expect(config.parseTrustProxy(raw, 1)).toBe(hops);
});

test.each(['10.0.0.1', '172.16.0.0/12', 'true', '1.5', '6', '-1', 'loopback'])('%p is refused', (raw) => {
  expect(config.parseTrustProxy(raw, 1)).toBeNull();
});

test('unset keeps the default', () => {
  expect(config.parseTrustProxy(undefined, 1)).toBe(1);
  expect(config.parseTrustProxy('', 0)).toBe(0);
});

test('an invalid value is a fatal configuration error outside dev/test', () => {
  const saved = { env: config.env, trustProxy: config.trustProxy, raw: process.env.TRUST_PROXY };
  try {
    config.env = 'production';
    config.trustProxy = null;
    process.env.TRUST_PROXY = '10.0.0.1';
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    expect(() => config.validateEnv(logger)).toThrow(/TRUST_PROXY must be a hop count/);
  } finally {
    config.env = saved.env;
    config.trustProxy = saved.trustProxy;
    if (saved.raw === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved.raw;
  }
});
