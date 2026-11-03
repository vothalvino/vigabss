// =============================================================================
// VigaBSS 5.0 — money arithmetic in integer centavos (BIL-31)
// =============================================================================
// Amounts were rounded by hand with Math.round(x * 100) / 100. A product such
// as 2.01 GB × 0.50 is 1.005 exactly but 1.00499999… as a float, so it was
// stored as 1.00 instead of 1.01, while MySQL DECIMAL and SAT round half up
// to 1.01. Sums of floats (subtotal + tax) were stored unrounded.
//
// Every value here is parsed from its decimal text into integer units and
// multiplied with BigInt, so a half cent is always seen as a half cent and
// rounded half away from zero, which is what DECIMAL columns and SAT do.
// Results are plain 2-decimal Numbers for the existing call sites.
// =============================================================================

'use strict';

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * Exact decimal value of `value` as { int: BigInt, scale } with
 * value = int / 10^scale. A Number is read from its shortest round-trip text
 * (0.1 → "0.1"), which is the value it was written as.
 */
function parseDecimal(value) {
  if (typeof value === 'bigint') return { int: value, scale: 0 };
  const text = String(value ?? 0).trim();
  const match = DECIMAL.exec(text === '' ? '0' : text);
  if (!match || (match[2] === '' && (match[3] === undefined || match[3] === ''))) {
    throw new TypeError(`Not a decimal amount: ${text}`);
  }
  const [, sign, whole, frac = '', exp = '0'] = match;
  let digits = `${whole}${frac}` || '0';
  let scale = frac.length - Number(exp);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  const int = BigInt(digits) * (sign === '-' ? -1n : 1n);
  return { int, scale };
}

const TEN = 10n;
const pow10 = n => TEN ** BigInt(n);

/** Divide, rounding half away from zero. */
function divRound(numerator, denominator) {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

/** Integer centavos of `value` as a BigInt, rounded half away from zero. */
function cents(value) {
  const { int, scale } = parseDecimal(value);
  return scale <= 2 ? int * pow10(2 - scale) : divRound(int, pow10(scale - 2));
}

/** Integer centavos of `value`, rounded half away from zero. */
function toCents(value) {
  return Number(cents(value));
}

/** A 2-decimal Number from integer centavos. */
function fromCents(cents) {
  return Number(cents) / 100;
}

/** `value` rounded half up to 2 decimals. */
function round(value) {
  return fromCents(cents(value));
}

/** Sum of the values, each first rounded to cents. */
function add(...values) {
  return fromCents(values.reduce((sum, v) => sum + cents(v), 0n));
}

/** a − b, each first rounded to cents. */
function sub(a, b) {
  return fromCents(cents(a) - cents(b));
}

/** a × b exactly, then rounded half up to cents (quantity × price, base × rate). */
function mul(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = x.scale + y.scale;
  const product = x.int * y.int;
  return fromCents(scale <= 2 ? product * pow10(2 - scale) : divRound(product, pow10(scale - 2)));
}

/** a ÷ b, rounded half up to cents (an amount ÷ quantity, a total ÷ (1 + rate)). */
function div(a, b) {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (y.int === 0n) throw new RangeError('Division by zero');
  // (x.int / 10^xs) / (y.int / 10^ys) × 100 = x.int × 10^(ys + 2) / (y.int × 10^xs)
  return fromCents(divRound(x.int * pow10(y.scale + 2), y.int * pow10(x.scale)));
}

/**
 * Split `total` over `weights` in proportion, in whole cents, by largest
 * remainder: the parts always add up to `total` exactly.
 * @param {number|string} total
 * @param {Array<number|string>} weights
 * @returns {number[]}
 */
function allocate(total, weights) {
  const totalCents = cents(total);
  const w = weights.map(v => cents(v));
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0);
  const shares = w.map(x => totalCents * x);
  const floors = shares.map(s => s / sum);
  let left = totalCents - floors.reduce((a, b) => a + b, 0n);
  const order = shares
    .map((s, i) => ({ i, rem: s % sum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  const parts = [...floors];
  for (const { i } of order) {
    if (left <= 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts.map(fromCents);
}

/** Whether a and b are within `toleranceCents` of each other. */
function withinTolerance(a, b, toleranceCents = 1) {
  const diff = cents(a) - cents(b);
  return (diff < 0n ? -diff : diff) <= BigInt(toleranceCents);
}

/** Whether a and b are the same amount once rounded to cents. */
function equal(a, b) {
  return cents(a) === cents(b);
}

module.exports = {
  toCents, fromCents, round, add, sub, mul, div, allocate, withinTolerance, equal,
};
