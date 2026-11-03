// =============================================================================
// FE-21 — the app loads what the page needs
// =============================================================================
// App.tsx imported about 165 pages statically, i18n bundled all three
// catalogues, MarkdownView was imported eagerly by three pages, and the build
// published its source maps: one 3.9 MB bundle (918 KB gzipped) plus an 11 MB
// map. Pages and catalogues are now chunks of their own, maps stay private,
// and scripts/postbuild.mjs fails the build past a size budget.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- plain ESM build script without types
import { initialChunks, BUDGET_KB } from '../../scripts/postbuild.mjs';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', f), 'utf8');

describe('code splitting', () => {
  it('App.tsx imports no page statically but the sign-in and not-found screens', () => {
    const app = read('src/App.tsx');
    const eager = [...app.matchAll(/^import .* from '@\/pages\/([^']+)';$/gm)].map(m => m[1]).sort();
    expect(eager).toEqual(['Login', 'NotFound']);
    expect((app.match(/= lazy\(\(\) => import\('@\/pages\//g) || []).length).toBeGreaterThan(150);
    expect(app).toMatch(/<Suspense fallback=\{<LoadingState \/>\}>\s*<Routes>/);
  });

  it('the locale catalogues are loaded on demand, not bundled', () => {
    const i18n = read('src/i18n/index.ts');
    expect(i18n).not.toMatch(/^import \w+ from '\.\/locales\//m);
    expect(i18n).toMatch(/en: \(\) => import\('\.\/locales\/en\.json'\)/);
  });

  it('MarkdownView is imported lazily everywhere', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.tsx?$/.test(e.name)
          && /^import .*MarkdownView.* from '@\/components\/MarkdownView';$/m.test(fs.readFileSync(p, 'utf8'))) offenders.push(e.name);
      }
    };
    walk(path.resolve(__dirname, '..'));
    expect(offenders).toEqual([]);
  });

  it('source maps are hidden and the build runs the budget and precompression step', () => {
    expect(read('vite.config.ts')).toMatch(/sourcemap: 'hidden'/);
    expect(JSON.parse(read('package.json')).scripts.build).toMatch(/vite build && node scripts\/postbuild\.mjs$/);
    expect(BUDGET_KB).toBeLessThanOrEqual(200);
  });

  it('the budget counts the entry chunk and what it imports statically', () => {
    const manifest = {
      'index.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_vendor'] },
      _vendor: { file: 'assets/vendor-b.js', imports: ['_shared'] },
      _shared: { file: 'assets/shared-c.js' },
      'src/pages/Big.tsx': { file: 'assets/Big-d.js', isDynamicEntry: true },
    };
    expect(initialChunks(manifest).sort()).toEqual(['assets/index-a.js', 'assets/shared-c.js', 'assets/vendor-b.js']);
  });
});
