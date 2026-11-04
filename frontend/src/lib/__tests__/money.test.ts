// FE-23: the es-MX currency formatters ten pages declared for themselves are
// formatMoney. A copy that parsed blindly printed "$NaN" for a non-number.
import { describe, expect, it } from 'vitest';
import { formatMoney } from '../money';

describe('formatMoney', () => {
  it('formats a DECIMAL string or a number in its currency', () => {
    expect(formatMoney('1160.00', 'MXN')).toBe('$1,160.00');
    expect(formatMoney(25, 'USD')).toBe('USD\u00a025.00');
  });

  it('falls back to MXN when the row has no currency', () => {
    expect(formatMoney('10', '')).toBe('$10.00');
    expect(formatMoney('10', null)).toBe('$10.00');
  });

  it('shows a dash for a missing or non-numeric amount, never $NaN', () => {
    expect(formatMoney(null, 'MXN')).toBe('—');
    expect(formatMoney(undefined, 'MXN')).toBe('—');
    expect(formatMoney('', 'MXN')).toBe('—');
    expect(formatMoney('n/a', 'MXN')).toBe('—');
    expect(formatMoney('0', 'MXN')).toBe('$0.00');
  });
});
