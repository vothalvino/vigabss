'use strict';

// =============================================================================
// BIL-31 — integer-cent money arithmetic for persisted and SAT-bound amounts
// =============================================================================
// Math.round(x * 100) / 100 rounds a float, so an exact half cent such as
// 2.01 × 0.50 = 1.005 (1.00499999… as a float) became 1.00, where MySQL
// DECIMAL and SAT round half up to 1.01; and invoice totals were stored as an
// unrounded float sum. The property tests compare src/utils/money against an
// exact BigInt reference over seeded random inputs.
// =============================================================================

const money = require('../src/utils/money');
const { resolveLineItemPricing } = require('../src/utils/lineItemPricing');

// Deterministic generator (mulberry32) so a failure always reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(31);
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const centsText = c => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

// Exact reference: a × b for 2-decimal a and b is (ca × cb) / 10^4, rounded
// half away from zero to cents.
function refMulCents(ca, cb) {
  const p = BigInt(ca) * BigInt(cb);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const q = (abs + 50n) / 100n;
  return Number(neg ? -q : q);
}

describe('money helpers', () => {
  test('a half cent rounds up, unlike Math.round on the float', () => {
    expect(Math.round(2.01 * 0.5 * 100) / 100).toBe(1); // the old behaviour
    expect(money.mul(2.01, 0.5)).toBe(1.01);
    expect(money.mul('4.02', '0.25')).toBe(1.01);
    expect(money.round(1.005)).toBe(1.01);
    expect(money.round('2.675')).toBe(2.68);
    expect(money.round(-1.005)).toBe(-1.01);
    expect(money.add(0.1, 0.2)).toBe(0.3);
    expect(money.sub(100, 33.33)).toBe(66.67);
  });

  test('mul matches the exact product rounded half up (property)', () => {
    for (let i = 0; i < 5000; i++) {
      const ca = int(-100000, 100000);
      const cb = int(0, 100000);
      expect(money.toCents(money.mul(centsText(ca), centsText(cb)))).toBe(refMulCents(ca, cb));
      // Numbers parse to the same value as their text.
      expect(money.mul(ca / 100, cb / 100)).toBe(refMulCents(ca, cb) / 100);
    }
  });

  test('a tax at a SAT rate is the exact base × rate (property)', () => {
    for (let i = 0; i < 5000; i++) {
      const base = int(0, 10000000);
      for (const [rate, rateBp] of [['0.16', 1600], ['0.08', 800], ['0.160000', 1600]]) {
        const exact = BigInt(base) * BigInt(rateBp); // cents × 10^4
        const expected = Number((exact + 5000n) / 10000n);
        expect(money.toCents(money.mul(centsText(base), rate))).toBe(expected);
      }
    }
  });

  test('add and sub are exact in cents (property)', () => {
    for (let i = 0; i < 5000; i++) {
      const values = Array.from({ length: int(1, 12) }, () => int(-500000, 500000));
      const sum = values.reduce((a, b) => a + b, 0);
      expect(money.toCents(money.add(...values.map(v => v / 100)))).toBe(sum);
      expect(money.toCents(money.sub(values[0] / 100, sum / 100))).toBe(values[0] - sum);
    }
  });

  test('allocate always sums to the total and gives each part within a cent of its share (property)', () => {
    for (let i = 0; i < 2000; i++) {
      const total = int(0, 1000000);
      const weights = Array.from({ length: int(1, 10) }, () => int(1, 100000));
      const parts = money.allocate(total / 100, weights.map(w => w / 100));
      expect(money.toCents(money.add(...parts))).toBe(total);
      const wsum = weights.reduce((a, b) => a + b, 0);
      parts.forEach((part, k) => {
        expect(Math.abs(money.toCents(part) - (total * weights[k]) / wsum)).toBeLessThan(1);
      });
    }
  });

  test('div rounds half up, so base + remainder is exactly the payment (property)', () => {
    for (let i = 0; i < 5000; i++) {
      const pagado = int(1, 10000000);
      const base = money.div(pagado / 100, 1.16);
      const importe = money.sub(pagado / 100, base);
      expect(money.toCents(money.add(base, importe))).toBe(pagado);
      // base is the nearest cent to pagado / 1.16.
      expect(Math.abs(money.toCents(base) * 116 - pagado * 100)).toBeLessThanOrEqual(58);
    }
  });

  test('withinTolerance and equal compare in cents', () => {
    expect(money.equal('10.00', 10)).toBe(true);
    expect(money.equal(0.1 + 0.2, 0.3)).toBe(true);
    expect(money.withinTolerance(10, 10.01)).toBe(true);
    expect(money.withinTolerance(10, 10.02)).toBe(false);
  });

  test('rejects text that is not an amount', () => {
    expect(() => money.toCents('12,50')).toThrow(TypeError);
    expect(() => money.toCents('abc')).toThrow(TypeError);
    expect(() => money.div(1, 0)).toThrow(RangeError);
  });
});

describe('persisted amounts use it', () => {
  test('a line of 2.01 × 0.50 is 1.01', () => {
    expect(resolveLineItemPricing({ quantity: 2.01, unit_price: 0.5 })).toEqual({ qty: 2.01, unitPrice: 0.5, amount: 1.01 });
    // The sibling shape: the client-computed amount (1.01) is accepted.
    expect(resolveLineItemPricing({ quantity: '4.02', unit_price: '0.25', amount: '1.01' }).amount).toBe(1.01);
  });
});
