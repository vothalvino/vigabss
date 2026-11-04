// =============================================================================
// <label> elements not tied to a control (FE-22)
// =============================================================================
// A label is associated when it has htmlFor or wraps its control. One with
// neither is read by a screen reader as loose text, and clicking it does not
// focus the field. Counts them per file under frontend/src.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CONTROL = /<(input|select|textarea|Field|Checkbox|Toggle|Switch)\b/;

export function orphanLabels(src: string): number {
  let n = 0;
  const re = /<label\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/\bhtmlFor\s*=/.test(m[1]) || m[1].trimEnd().endsWith('/')) continue;
    const close = src.indexOf('</label>', re.lastIndex);
    const inner = close === -1 ? '' : src.slice(re.lastIndex, close);
    if (!CONTROL.test(inner)) n++;
  }
  return n;
}

export function scanLabels(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') walk(p); continue; }
      if (!p.endsWith('.tsx') || p.endsWith('.test.tsx')) continue;
      const n = orphanLabels(readFileSync(p, 'utf8'));
      if (n) out[relative(root, p)] = n;
    }
  };
  walk(root);
  return out;
}
