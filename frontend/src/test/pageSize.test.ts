// =============================================================================
// FE-23 — page size ratchet
// =============================================================================
// Ten pages had grown past 1,500 lines (ContractDetail ~2,700), each holding
// its own modals, fetchers and helpers. No source file may pass MAX_LINES;
// the ones already over may not grow, so a change to one splits something
// out instead. When a listed file shrinks, lower its entry in
// pageSizeBaseline.json in the same change (drop it once it is under).
// This stands in for an ESLint max-lines rule: the frontend has no ESLint.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import baseline from './fixtures/pageSizeBaseline.json';

const SRC = resolve(__dirname, '..');
const MAX_LINES = 1500;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') sourceFiles(p, out); continue; }
    if (/\.tsx?$/.test(p) && !/\.(test|d)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe('page size', () => {
  const lines = Object.fromEntries(sourceFiles(SRC).map(f => [
    relative(SRC, f).split('\\').join('/'),
    (readFileSync(f, 'utf8').match(/\n/g) ?? []).length,
  ]));
  const base = baseline as Record<string, number>;

  it(`no file passes ${MAX_LINES} lines, or its baseline if it already did`, () => {
    const over = Object.entries(lines)
      .filter(([f, n]) => n > Math.max(MAX_LINES, base[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} lines (limit ${Math.max(MAX_LINES, base[f] ?? 0)})`);
    expect(over).toEqual([]);
  });

  it('the baseline is lowered when a listed file shrinks', () => {
    const stale = Object.entries(base)
      .filter(([f, n]) => (lines[f] ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, now ${lines[f] ?? 0}`);
    expect(stale).toEqual([]);
  });
});
