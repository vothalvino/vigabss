#!/usr/bin/env node
// =============================================================================
// After `vite build` (FE-21)
// =============================================================================
// 1. Size budget: the JavaScript the browser must load before the first page
//    renders (the entry chunk and its static imports) may not grow past
//    BUDGET_KB gzipped. The app once shipped as a single 3.9 MB bundle.
// 2. Precompression: every text asset gets a .gz beside it, which the app
//    serves to browsers that accept gzip (src/app.js). Express does not
//    compress, and the host-nginx and Kubernetes topologies do not either.
// 3. Source maps are built 'hidden' (no sourceMappingURL) and moved out of
//    dist/ into dist-sourcemaps/, so they are never published.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const mapsDir = path.join(root, 'dist-sourcemaps');
export const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB || 200);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? walk(path.join(dir, e.name))
    : [path.join(dir, e.name)]));
}

/** The entry chunk and every chunk it imports statically, from the manifest. */
export function initialChunks(manifest) {
  const entry = Object.values(manifest).find(c => c.isEntry);
  if (!entry) throw new Error('No entry chunk in the Vite manifest');
  const seen = new Set();
  const visit = (key) => {
    const chunk = manifest[key] ?? entry;
    if (seen.has(chunk.file)) return;
    seen.add(chunk.file);
    for (const imp of chunk.imports ?? []) visit(imp);
  };
  visit(Object.keys(manifest).find(k => manifest[k] === entry));
  return [...seen].filter(f => f.endsWith('.js'));
}

function main() {
  // 3. Source maps
  fs.rmSync(mapsDir, { recursive: true, force: true });
  for (const file of walk(dist).filter(f => f.endsWith('.map'))) {
    const target = path.join(mapsDir, path.relative(dist, file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(file, target);
  }

  // 1. Budget
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, '.vite', 'manifest.json'), 'utf8'));
  const initial = initialChunks(manifest);
  const initialGzKb = initial
    .reduce((sum, f) => sum + zlib.gzipSync(fs.readFileSync(path.join(dist, f)), { level: 9 }).length, 0) / 1024;
  console.log(`Initial JavaScript: ${initial.length} chunk(s), ${initialGzKb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`);

  // 2. Precompression
  let count = 0;
  for (const file of walk(dist).filter(f => /\.(js|css|html|svg|json|txt|webmanifest)$/.test(f))) {
    const body = fs.readFileSync(file);
    if (body.length < 1024) continue;
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync(body, { level: 9 }));
    count += 1;
  }
  console.log(`Precompressed ${count} asset(s)`);

  if (initialGzKb > BUDGET_KB) {
    console.error(`Bundle budget exceeded: ${initialGzKb.toFixed(1)} KB > ${BUDGET_KB} KB. Load the new code lazily or raise BUNDLE_BUDGET_KB with a reason.`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
