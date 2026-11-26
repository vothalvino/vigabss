// The Payments page follows the theme: its surfaces, borders and plain text
// come from the theme variables, so it turns dark in dark mode. Status badges
// keep their own fixed colours.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const FILES = ['pages/PaymentList.tsx', 'pages/payments/PaymentActions.tsx'];

describe('Payments page in dark mode', () => {
  it.each(FILES)('%s paints no fixed white or light-grey surface', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/background: '#(fff|ffffff|fafafa|f9fafb|f3f4f6|f8faff|fafff8)'/i);
    expect(src).not.toMatch(/\? '#fff' : '#fafafa'/);
  });

  it.each(FILES)('%s writes plain text and borders in theme colours', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/color: '#(374151|4b5563|6b7280|9ca3af)'/i);
    expect(src).not.toMatch(/1px solid #(f3f4f6|e5e7eb)/i);
  });

  it('the table uses the theme surfaces', () => {
    const src = read('pages/PaymentList.tsx');
    expect(src).toContain("background: 'var(--bg-card)'");
    expect(src).toContain("'var(--bg-card)' : 'var(--bg-body)'");
    expect(src).toContain("background: 'var(--bg-subtle)'");
  });
});
