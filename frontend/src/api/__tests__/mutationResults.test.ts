// FE2-09 — openapi-fetch resolves with { error } instead of throwing, so a
// mutation that returns or discards the result reports success on a 403/500.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mutations check the openapi-fetch result', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== '__tests__') walk(full); continue; }
      if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts') || name.includes('.test.')) continue;
      readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(await|return) api\.(POST|PUT|PATCH|DELETE)\(/.test(line)) offenders.push(`${full}:${i + 1}`);
      });
    }
  };
  walk(join(__dirname, '..', '..'));

  it('no write call is returned or awaited without reading its error', () => {
    expect(offenders).toEqual([]);
  });
});
