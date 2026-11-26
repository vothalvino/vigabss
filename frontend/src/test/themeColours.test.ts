// Staff screens follow the theme. Their surfaces, borders, plain text and
// status colours come from the theme tokens in index.css, so a screen turns
// dark in dark mode instead of staying white.
//
// Not covered, because they draw on a surface that stays white whatever the
// theme: maps and their popups, signature pads, the contract signing page,
// printed receipts, and the reseller and carrier apps (which have their own
// stylesheet).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');
const EXEMPT = /map|signature|signing|qr|print|receipt|punto\/|ruta\/|portal\/portallogin/i;

function screens(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== '__tests__' && name !== 'test') screens(full, out); continue; }
    if (!name.endsWith('.tsx') || name.includes('.test.')) continue;
    const rel = relative(SRC, full).replace(/\\/g, '/');
    const src = readFileSync(full, 'utf8');
    if (EXEMPT.test(rel) || src.includes('leaflet')) continue;
    out.push(rel);
  }
  return out;
}

const FILES = screens(SRC);
const offenders = (pattern: RegExp) => FILES.filter((f) => pattern.test(readFileSync(join(SRC, f), 'utf8')));

describe('staff screens follow the theme', () => {
  it('finds the screens', () => {
    expect(FILES.length).toBeGreaterThan(150);
    expect(FILES).toContain('pages/PaymentList.tsx');
    expect(FILES).toContain('pages/InvoiceList.tsx');
  });

  it('none paints a fixed white or light-grey surface', () => {
    expect(offenders(/(?:background|backgroundColor): '#(?:fff|ffffff|fafafa|f9fafb|f8fafc|f3f4f6|f5f5f5|f0f0f0|f8f9fa)'/i)).toEqual([]);
  });

  it('none writes plain text in a fixed grey', () => {
    expect(offenders(/\bcolor: '#(?:111827|1f2937|374151|4b5563|6b7280|9ca3af)'/i)).toEqual([]);
  });

  it('none draws a border in a fixed light grey', () => {
    expect(offenders(/1px solid #(?:f3f4f6|e5e7eb)\b/i)).toEqual([]);
  });

  it('the theme defines every token the screens use, for light and dark', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const dark = css.slice(css.indexOf('[data-theme="dark"]'));
    for (const token of ['--bg-card', '--bg-body', '--bg-subtle', '--border', '--text-primary', '--text-secondary', '--text-muted',
      '--success', '--success-soft', '--danger', '--danger-soft', '--warning', '--warning-soft', '--info', '--info-soft']) {
      expect([token, css.includes(`${token}:`), dark.includes(`${token}:`)]).toEqual([token, true, true]);
    }
  });
});
