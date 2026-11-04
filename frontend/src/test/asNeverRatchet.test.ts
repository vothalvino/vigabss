// =============================================================================
// FE-23 — `as never` ratchet
// =============================================================================
// About 1,200 `as never` casts hid the OpenAPI types from the pages: paths the
// spec did not document, query parameters it did not declare, and untyped
// responses generated as Record<string, never>. With the paths and parameters
// documented and untyped responses generated as unknown
// (gen:api --empty-objects-unknown), most casts were not needed and were
// removed. No file may add one; when a file's count drops, lower its entry in
// asNeverBaseline.json in the same change.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import baseline from './fixtures/asNeverBaseline.json';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') sourceFiles(p, out); continue; }
    if (/\.tsx?$/.test(p) && !/\.(test|d)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function castCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const n = (readFileSync(file, 'utf8').match(/\bas never\b/g) ?? []).length;
    if (n) counts[relative(SRC, file).split('\\').join('/')] = n;
  }
  return counts;
}

describe('as never casts', () => {
  const counts = castCounts();
  const base = baseline as Record<string, number>;

  it('no file has more casts than its baseline', () => {
    const over = Object.entries(counts).filter(([f, n]) => n > (base[f] ?? 0)).map(([f, n]) => `${f}: ${n} (baseline ${base[f] ?? 0})`);
    expect(over).toEqual([]);
  });

  it('the baseline is lowered when casts are removed', () => {
    const stale = Object.entries(base).filter(([f, n]) => (counts[f] ?? 0) < n).map(([f, n]) => `${f}: baseline ${n}, now ${counts[f] ?? 0}`);
    expect(stale).toEqual([]);
  });
});
