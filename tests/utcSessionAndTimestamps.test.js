// =============================================================================
// DB-27 — every pooled connection pins its session to UTC, and user-chosen
// TIMESTAMP dates past 2038 are refused
// =============================================================================
// mysql2's `timezone` converts only JS Dates on the client; NOW(),
// CURRENT_TIMESTAMP and TIMESTAMP columns follow the server session time_zone,
// which an external MySQL may not set to UTC. api_tokens.expires_at and
// promotions.starts_at/ends_at are TIMESTAMP, so a post-2038 date failed the
// INSERT with a 500.
// =============================================================================
'use strict';

describe('session time zone', () => {
  beforeEach(() => jest.resetModules());

  test('the primary pool runs SET time_zone on each new connection', () => {
    const { EventEmitter } = require('events');
    const pool = Object.assign(new EventEmitter(), { execute: jest.fn(), getConnection: jest.fn(), end: jest.fn() });
    jest.doMock('mysql2/promise', () => ({ createPool: jest.fn(() => pool) }));
    jest.doMock('../src/utils/dbMetrics', () => ({
    recordDbQuery: jest.fn(), registerPoolStats: jest.fn(), recordPoolAcquire: jest.fn(), notePoolAcquireFailure: jest.fn(),
  }));
    require('../src/config/database');
    const conn = { query: jest.fn((sql, cb) => cb(null)), destroy: jest.fn() };
    pool.emit('connection', conn);
    expect(conn.query).toHaveBeenCalledWith("SET time_zone = '+00:00'", expect.any(Function));
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  test('a connection that cannot be pinned is destroyed', () => {
    const { EventEmitter } = require('events');
    const pool = Object.assign(new EventEmitter(), { execute: jest.fn(), getConnection: jest.fn(), end: jest.fn() });
    jest.doMock('mysql2/promise', () => ({ createPool: jest.fn(() => pool) }));
    jest.doMock('../src/utils/dbMetrics', () => ({
    recordDbQuery: jest.fn(), registerPoolStats: jest.fn(), recordPoolAcquire: jest.fn(), notePoolAcquireFailure: jest.fn(),
  }));
    require('../src/config/database');
    const conn = { query: jest.fn((sql, cb) => cb(new Error('denied'))), destroy: jest.fn() };
    pool.emit('connection', conn);
    expect(conn.destroy).toHaveBeenCalled();
  });
});

describe('TIMESTAMP-range dates', () => {
  const { validate } = require('../src/middleware/validate');
  const { createApiToken } = require('../src/middleware/schemas/apiTokens');
  const { createPromotion } = require('../src/middleware/schemas/promotions');
  const run = (schema, body) => { const next = jest.fn(); validate(schema)({ body }, {}, next); return next.mock.calls[0][0]; };

  test.each([
    [createApiToken, { name: 't', expires_at: '2040-01-01' }],
    [createPromotion, { name: 'p', code: 'X', ends_at: '2099-12-31T00:00:00Z' }],
    [createPromotion, { name: 'p', code: 'X', starts_at: 'not a date' }],
  ])('refuses %#', (schema, body) => {
    const err = run(schema, body);
    expect(err).toBeDefined();
    expect(err.details.some((d) => /expires_at|ends_at|starts_at/.test(d.field))).toBe(true);
  });

  test('accepts a date inside the range', () => {
    const err = run(createApiToken, { name: 't', expires_at: '2030-06-01T00:00:00Z' });
    expect(err?.details?.some((d) => d.field === 'expires_at')).not.toBe(true);
  });
});
