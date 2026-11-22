// =============================================================================
// Every theme colour a screen uses is defined
// =============================================================================
// `background: var(--bg-input)` with --bg-input defined nowhere is an invalid
// declaration: the element keeps the browser's default background while the
// rest of the theme applies, which in dark mode gave a select with light text
// on a light popup. A fallback such as `var(--bg-primary, #fff)` hides the
// same mistake behind a hard-coded light colour. So: a `var(--name)` used in
// the source must be a custom property some stylesheet defines.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

function files(dir: string, pattern: RegExp, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') files(p, pattern, out); continue; }
    if (pattern.test(p) && !/\.(test|d)\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

// Set at run time on the element itself (style={{ '--len': n }}), not by a stylesheet.
const SET_INLINE = new Set(['--len']);

describe('theme colours', () => {
  const defined = new Set<string>();
  for (const f of files(SRC, /\.css$/)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(^|[\s;{])(--[a-z0-9-]+)\s*:/g)) defined.add(m[2]);
  }

  it('finds the stylesheet tokens', () => {
    expect(defined.has('--bg-card')).toBe(true);
    expect(defined.has('--input-bg')).toBe(true);
  });

  it('no screen uses a custom property that is defined nowhere', () => {
    const missing = new Map<string, string>();
    for (const f of files(SRC, /\.(tsx?|css)$/)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*[,)]/g)) {
        const name = m[1];
        if (!defined.has(name) && !SET_INLINE.has(name) && !missing.has(name)) {
          missing.set(name, relative(SRC, f).split('\\').join('/'));
        }
      }
    }
    expect([...missing].map(([name, file]) => `${name} (first seen in ${file})`)).toEqual([]);
  });

  it('the older names are aliases that follow the theme, not fixed colours', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toMatch(/--bg-input:\s*var\(--input-bg\);/);
    expect(css).toMatch(/--bg-primary:\s*var\(--bg-card\);/);
    expect(css).toMatch(/--primary:\s*var\(--accent\);/);
  });
});
