// On a phone every table must be reachable: its holder scrolls sideways even
// when the page gave that holder `overflow: hidden`, and a many-column table
// keeps a workable width. The rule lives in index.css; this keeps it there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
const phone = css.slice(css.lastIndexOf('@media (max-width: 768px)'));
const paymentList = readFileSync(join(__dirname, '..', 'pages', 'PaymentList.tsx'), 'utf8');

describe('tables on a phone', () => {
  it('makes whatever holds a table scroll sideways, over an inline clip', () => {
    expect(phone).toMatch(/\.app-main :has\(> table\)\s*\{[^}]*overflow-x:\s*auto\s*!important/);
  });

  it('keeps a workable width for tables with many columns', () => {
    expect(phone).toMatch(/table:has\(tr > :nth-child\(6\)\)\s*\{[^}]*min-width:\s*760px/);
    expect(phone).toMatch(/table:has\(tr > :nth-child\(9\)\)\s*\{[^}]*min-width:\s*980px/);
  });

  it('keeps the Payments row buttons on one line', () => {
    expect(paymentList).toContain('className="row-actions-one-line"');
    expect(css).toMatch(/\.row-actions-one-line > div\s*\{[^}]*flex-wrap:\s*nowrap\s*!important/);
  });
});
