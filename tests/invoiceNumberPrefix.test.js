'use strict';

// =============================================================================
// The prefix of invoice numbers
// =============================================================================
// Every invoice was INV-000123. An organization now has its own letters
// (Invoice Settings), and with none chosen a Mexican organization numbers
// REM- (the document is a remisión) and any other INV-. The counter is the
// same one, so numbers keep running whatever the prefix.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const settings = require('../src/services/invoiceSettingsService');
const billingService = require('../src/services/billingService');

beforeEach(() => jest.clearAllMocks());

describe('the prefix an organization uses', () => {
  const row = (r) => db.query.mockResolvedValueOnce([[r]]);

  test('its own, else REM in Mexico and INV elsewhere', async () => {
    row({ number_prefix: null, locale: 'MX' });
    expect(await settings.numberPrefix(1)).toEqual({ chosen: null, fallback: 'REM', effective: 'REM' });
    row({ number_prefix: null, locale: 'global' });
    expect(await settings.numberPrefix(2)).toEqual({ chosen: null, fallback: 'INV', effective: 'INV' });
    row({ number_prefix: 'NOTA', locale: 'MX' });
    expect(await settings.numberPrefix(1)).toEqual({ chosen: 'NOTA', fallback: 'REM', effective: 'NOTA' });
    expect(db.query.mock.calls[0][1]).toEqual([1]);
  });

  test('an install with no organization keeps INV, without a query', async () => {
    expect(await settings.numberPrefix(null)).toEqual({ chosen: null, fallback: 'INV', effective: 'INV' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test.each([
    ['rem', 'REM'], [' Fac-2026 ', 'FAC-2026'], ['nota-', 'NOTA'], ['A1', 'A1'], ['', null], ['   ', null], [null, null], ['---', null],
  ])('%j is stored as %j', (given, stored) => {
    expect(settings.cleanPrefix(given)).toBe(stored);
  });

  test.each(['A B', 'TOO-LONG-PREFIX', '-X', 'A/B', 'ñ', 'A_B'])('%j is refused', (given) => {
    expect(() => settings.cleanPrefix(given)).toThrow(/number_prefix/);
  });
});

describe('saving the settings', () => {
  const save = async (body) => {
    db.query.mockResolvedValue([[{ id: 1 }]]);
    await settings.upsertInvoiceSettings(1, body);
    return db.query.mock.calls[0];
  };

  test('a prefix that is sent is stored; one left out of the request is kept', async () => {
    let [sql, params] = await save({ header_color: '#000000', number_prefix: 'fac' });
    expect(sql).toMatch(/number_prefix\s+= IF\(\?, VALUES\(number_prefix\), number_prefix\)/);
    expect(params.slice(-2)).toEqual(['FAC', 1]);
    jest.clearAllMocks();
    [sql, params] = await save({ header_color: '#000000' });
    expect(params.slice(-2)).toEqual([null, 0]);
    jest.clearAllMocks();
    // Sent empty: back to the default.
    [sql, params] = await save({ number_prefix: '' });
    expect(params.slice(-2)).toEqual([null, 1]);
  });

  test('a prefix the system does not accept stores nothing', async () => {
    await expect(settings.upsertInvoiceSettings(1, { number_prefix: 'A B' })).rejects.toMatchObject({ statusCode: 422 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the next invoice number', () => {
  function conn(number, prefixRow) {
    return {
      execute: jest.fn().mockResolvedValue([{}]),
      query: jest.fn(async (sql) => (/LAST_INSERT_ID\(\) AS id/.test(sql) ? [[{ id: number }]] : [[prefixRow]])),
    };
  }

  test('takes the prefix and keeps the same running number', async () => {
    expect(await billingService.nextInvoiceNumber(conn(60, { number_prefix: null, locale: 'MX' }), 1)).toBe('REM-000060');
    expect(await billingService.nextInvoiceNumber(conn(61, { number_prefix: null, locale: 'global' }), 2)).toBe('INV-000061');
    expect(await billingService.nextInvoiceNumber(conn(62, { number_prefix: 'FAC-2026', locale: 'MX' }), 1)).toBe('FAC-2026-000062');
  });

  test('reads the prefix on the caller\'s own connection, inside its transaction', async () => {
    const c = conn(7, { number_prefix: null, locale: 'MX' });
    await billingService.nextInvoiceNumber(c, 1);
    expect(c.query.mock.calls.some(([sql]) => /FROM organizations o/.test(sql))).toBe(true);
    expect(db.query).not.toHaveBeenCalled();
  });
});
