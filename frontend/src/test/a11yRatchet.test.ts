// =============================================================================
// FE-22 — accessibility ratchets
// =============================================================================
// - About 580 <label> elements were tied to no control (no htmlFor, nothing
//   wrapped). No file may add one; when a file's count drops, lower its entry
//   in labelBaseline.json in the same change.
// - DialogFocusManager keeps focus inside role="dialog" aria-modal="true".
//   A dialog without aria-modal is not managed, so it must be a reviewed
//   non-modal popover.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { orphanLabels, scanLabels } from './helpers/labelScan';
import baseline from './fixtures/labelBaseline.json';

const SRC = resolve(__dirname, '..');

// Non-modal popovers: they do not block the page, so focus is not trapped.
const POPOVERS: Record<string, string> = {
  'components/NotificationBell.tsx': 'the notifications dropdown',
};

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') tsxFiles(p, out); continue; }
    if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

describe('labels', () => {
  const counts = scanLabels(SRC);
  const base = baseline as Record<string, number>;

  it('the scanner tells a tied label from a loose one', () => {
    expect(orphanLabels('<label style={s}>Amount</label><input />')).toBe(1);
    expect(orphanLabels('<label htmlFor={id}>Amount</label><input id={id} />')).toBe(0);
    expect(orphanLabels('<label><input type="checkbox" /> Internal</label>')).toBe(0);
  });

  it('no file has more loose labels than its baseline', () => {
    const over = Object.entries(counts).filter(([f, n]) => n > (base[f] ?? 0)).map(([f, n]) => `${f}: ${n} (baseline ${base[f] ?? 0})`);
    expect(over).toEqual([]);
  });

  it('the baseline is lowered when labels are fixed', () => {
    const stale = Object.entries(base).filter(([f, n]) => (counts[f] ?? 0) < n).map(([f, n]) => `${f}: baseline ${n}, now ${counts[f] ?? 0}`);
    expect(stale).toEqual([]);
  });
});

describe('dialogs', () => {
  it('every role="dialog" is aria-modal, or a reviewed popover', () => {
    const unmanaged: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const rel = relative(SRC, file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<\w+\b[^>]*\brole="(?:alert)?dialog"[^>]*>/g)) {
        if (!/aria-modal/.test(m[0]) && !POPOVERS[rel]) unmanaged.push(rel);
      }
    }
    expect(unmanaged).toEqual([]);
  });
});
