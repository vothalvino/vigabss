// =============================================================================
// FE-23 — `as never` / `as unknown as` ratchet
// =============================================================================
// About 1,200 `as never` casts hid the OpenAPI types from the pages: paths the
// spec did not document, query parameters it did not declare, and untyped
// responses generated as Record<string, never>. With the paths and parameters
// documented and untyped responses generated as unknown
// (gen:api --empty-objects-unknown), most casts were not needed and were
// removed. The billing, ticket and contract reads are typed from schema.sql,
// so their `res.data as unknown as …` casts went too. No file may add either
// cast; when a file's count drops, lower its entry in asNeverBaseline.json or
// asUnknownBaseline.json in the same change.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import neverBaseline from './fixtures/asNeverBaseline.json';
import unknownBaseline from './fixtures/asUnknownBaseline.json';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') sourceFiles(p, out); continue; }
    if (/\.tsx?$/.test(p) && !/\.(test|d)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function castCounts(cast: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const n = (readFileSync(file, 'utf8').match(cast) ?? []).length;
    if (n) counts[relative(SRC, file).split('\\').join('/')] = n;
  }
  return counts;
}

describe.each([
  ['as never', /\bas never\b/g, neverBaseline],
  ['as unknown as', /\bas unknown as\b/g, unknownBaseline],
] as const)('%s casts', (_name, cast, baseline) => {
  const counts = castCounts(cast);
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
