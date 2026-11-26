'use strict';

// =============================================================================
// Money tie-out — the rules of the safe and the month, without a database
// =============================================================================
// The sums themselves are proved against MySQL
// (tests/integration/db/moneyTieOut.test.js). These pin what can be decided
// from the service alone: who may reach the routes, which month is read, and
// what a safe movement is refused for.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), execute: jest.fn(), getConnection: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const service = require('../src/services/moneyTieOutService');

// What the safe holds in these tests: counted once, then `flows` moved.
function safe({ counted = true, corrections = 0, pickups = 0, deposits = 0, account = { id: 4, status: 'active' } } = {}) {
  const inserts = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/MIN\(moved_at\) AS since/.test(sql)) return [[counted ? { since: new Date('2026-11-01T06:00:00Z'), corrections } : { since: null, corrections: 0 }]];
    if (/FROM cash_reconciliation_pickups/.test(sql)) return [[{ total: pickups }]];
    if (/FROM cash_bags/.test(sql)) return [[{ total: 0 }]];
    if (/FROM reseller_ledger_entries/.test(sql)) return [[{ total: 0 }]];
    if (/GROUP BY kind/.test(sql)) return [deposits ? [{ kind: 'deposit', total: deposits }] : []];
    if (/FROM bank_accounts WHERE id = \?/.test(sql)) return [account ? [{ name: 'A', purpose: 'any', ...account }] : []];
    if (/INSERT INTO cash_safe_movements/.test(sql)) { inserts.push(params); return [{ insertId: 77 }]; }
    return [[]];
  });
  return inserts;
}

beforeEach(() => jest.clearAllMocks());

describe('the month that is read', () => {
  test('a month runs from its first day to the first of the next, December into January', () => {
    expect(service.monthRange(2026, 11)).toMatchObject({ from: '2026-11-01', to: '2026-12-01' });
    expect(service.monthRange(2026, 12)).toMatchObject({ from: '2026-12-01', to: '2027-01-01' });
  });

  test('a year or month out of range is refused, and so is a month that has not started', async () => {
    expect(() => service.monthRange(1999, 1)).toThrow(/year/);
    expect(() => service.monthRange(2026, 13)).toThrow(/month/);
    expect(() => service.monthRange(2026, 'x')).toThrow(/month/);
    await expect(service.report(1, 2027, 1, new Date('2026-11-26T12:00:00Z'))).rejects.toThrow(/has not started/);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('the safe', () => {
  test('its balance is every count correction plus what moved since the first count; unknown before it', async () => {
    safe({ corrections: -5, pickups: 200, deposits: 120 });
    expect(await service.safeBalance(1, new Date())).toBe(75);
    safe({ counted: false });
    expect(await service.safeBalance(1, new Date())).toBeNull();
  });

  test('a count stores what the safe should have held, and may be 0', async () => {
    const inserts = safe({ pickups: 200 });
    const out = await service.recordSafeMovement(1, 9, { kind: 'count', amount: 0 });
    expect(out).toMatchObject({ id: 77, kind: 'count', amount: 0, expected_amount: 200 });
    // organization, kind, amount, expected, account, when, reference, note, who
    expect(inserts[0].slice(0, 5)).toEqual([1, 'count', 0, 200, null]);
    expect(inserts[0][8]).toBe(9);
  });

  test('the first count is accepted when nothing is tracked yet; anything else is refused until then', async () => {
    const inserts = safe({ counted: false });
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 10, bank_account_id: 4 })).rejects.toMatchObject({ code: 'SAFE_NOT_COUNTED' });
    await expect(service.recordSafeMovement(1, 9, { kind: 'other_in', amount: 10 })).rejects.toMatchObject({ code: 'SAFE_NOT_COUNTED' });
    await service.recordSafeMovement(1, 9, { kind: 'count', amount: 350 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].slice(1, 4)).toEqual(['count', 350, 0]);
  });

  test('a deposit needs an active account of this organization and cannot exceed what the safe holds', async () => {
    let inserts = safe({ pickups: 200 });
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 50 })).rejects.toThrow(/bank account/);
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 0, bank_account_id: 4 })).rejects.toThrow(/more than 0/);
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 200.01, bank_account_id: 4 })).rejects.toMatchObject({ code: 'SAFE_INSUFFICIENT', details: { in_safe: 200, amount: 200.01 } });
    await expect(service.recordSafeMovement(1, 9, { kind: 'other_out', amount: 300 })).rejects.toMatchObject({ code: 'SAFE_INSUFFICIENT' });
    expect(inserts).toHaveLength(0);
    await service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 200, bank_account_id: 4, reference: 'slip' });
    expect(inserts[0].slice(0, 5)).toEqual([1, 'deposit', 200, null, 4]);

    inserts = safe({ pickups: 200, account: { id: 4, status: 'inactive' } });
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 50, bank_account_id: 4 })).rejects.toMatchObject({ code: 'BANK_ACCOUNT_INACTIVE' });
    inserts = safe({ pickups: 200, account: null });
    await expect(service.recordSafeMovement(1, 9, { kind: 'deposit', amount: 50, bank_account_id: 4 })).rejects.toMatchObject({ statusCode: 404 });
    expect(inserts).toHaveLength(0);
  });

  test('cash into the safe has no ceiling; a date in the future or an unknown kind is refused', async () => {
    const inserts = safe({ pickups: 0 });
    await service.recordSafeMovement(1, 9, { kind: 'other_in', amount: 5000 });
    expect(inserts).toHaveLength(1);
    await expect(service.recordSafeMovement(1, 9, { kind: 'count', amount: 1, moved_at: new Date(Date.now() + 3600e3).toISOString() })).rejects.toThrow(/future/);
    await expect(service.recordSafeMovement(1, 9, { kind: 'count', amount: 1, moved_at: 'yesterday-ish' })).rejects.toThrow(/not a date/);
    await expect(service.recordSafeMovement(1, 9, { kind: 'loan', amount: 1 })).rejects.toThrow(/kind must be/);
  });

  test('the count the safe is tracked from cannot be removed while other movements rest on it', async () => {
    const updates = [];
    const answer = (row, other) => db.query.mockImplementation(async (sql) => {
      if (/SELECT id, kind, amount, moved_at FROM cash_safe_movements/.test(sql)) return [row ? [row] : []];
      if (/AS earlier_counts/.test(sql)) return [[other]];
      if (/UPDATE cash_safe_movements SET deleted_at/.test(sql)) { updates.push(sql); return [{ affectedRows: 1 }]; }
      return [[]];
    });
    const first = { id: 1, kind: 'count', amount: '0.00', moved_at: new Date('2026-11-01T06:00:00Z') };
    answer(first, { earlier_counts: 0, others: 3 });
    await expect(service.removeSafeMovement(1, 1)).rejects.toMatchObject({ code: 'SAFE_COUNT_IN_USE', statusCode: 409 });
    expect(updates).toHaveLength(0);
    answer(first, { earlier_counts: 0, others: 0 });
    expect(await service.removeSafeMovement(1, 1)).toEqual({ id: 1, kind: 'count', amount: 0 });
    answer({ ...first, id: 5 }, { earlier_counts: 1, others: 9 });
    await service.removeSafeMovement(1, 5);
    answer({ id: 8, kind: 'deposit', amount: '90.00', moved_at: new Date() }, null);
    await service.removeSafeMovement(1, 8);
    expect(updates).toHaveLength(3);
    answer(null);
    await expect(service.removeSafeMovement(1, 99)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('who may use it', () => {
  test('every route is for whoever supervises the cash, and each write is audited', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'moneyTieOut.js'), 'utf8');
    expect(src).toMatch(/const supervisor = requirePermission\('cash_reconciliation\.approve'\);/);
    const routes = src.match(/^router\.(get|post|put|delete)\(.*$/gm);
    expect(routes).toHaveLength(7);
    for (const line of routes) expect(line).toMatch(/^router\.\w+\('[^']*', supervisor,/);
    expect(src.match(/auditLog\.log\(/g)).toHaveLength(4);
  });
});
