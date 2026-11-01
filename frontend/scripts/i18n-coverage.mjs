#!/usr/bin/env node
// =============================================================================
// VigaBSS 0.1.0-alpha.1 — i18n message catalogue coverage checker
// =============================================================================
// Verifies that every key present in the English base catalogue (en.json) also
// exists in every other supported locale (es.json, pt-BR.json), and that every
// t('literal.key') call in src/ names a key en.json has or passes a default
// (FE-07): comparing catalogues alone reported 100% while pages rendered raw
// key paths.
//
// Exit codes:
//   0 — all locales are complete and every used key exists
//   1 — a key is missing in a non-English locale, or a used key is missing
//
// It also ratchets literal UI text (JSX text and visible attribute strings):
// no file may exceed its count in scripts/i18n-literal-baseline.json.
//
// Usage:
//   node scripts/i18n-coverage.mjs
//   npm run i18n:check
//   npm run i18n:baseline   (rewrite the literal baseline after translating)
// =============================================================================

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { findMissingKeys, countLiteralStrings, literalRegressions, LITERAL_BASELINE_PATH } from './i18n-usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '../src/i18n/locales');

const LOCALES = ['es', 'pt-BR'];
const BASE_LOCALE = 'en';

/**
 * Flatten a nested object into dot-separated keys.
 * e.g. { a: { b: 'v' } } → { 'a.b': 'v' }
 */
function flatten(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(acc, flatten(value, full));
    } else {
      acc[full] = value;
    }
    return acc;
  }, {});
}

function loadLocale(locale) {
  const path = join(LOCALES_DIR, `${locale}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

async function run() {
  const base = flatten(loadLocale(BASE_LOCALE));
  const baseKeys = Object.keys(base);

  let totalMissing = 0;

  console.log(`\ni18n coverage check — base locale: ${BASE_LOCALE} (${baseKeys.length} keys)\n`);

  for (const locale of LOCALES) {
    const target = flatten(loadLocale(locale));
    const missing = baseKeys.filter(k => !(k in target));
    const extra   = Object.keys(target).filter(k => !(k in base));

    const pct = (((baseKeys.length - missing.length) / baseKeys.length) * 100).toFixed(1);

    if (missing.length === 0) {
      console.log(`  ✅  ${locale.padEnd(8)} — ${baseKeys.length}/${baseKeys.length} keys (100%)`);
    } else {
      console.log(`  ❌  ${locale.padEnd(8)} — ${baseKeys.length - missing.length}/${baseKeys.length} keys (${pct}%) — ${missing.length} missing:`);
      for (const k of missing) {
        console.log(`       missing: ${k}`);
      }
      totalMissing += missing.length;
    }

    if (extra.length > 0) {
      console.log(`       ⚠️  ${extra.length} extra key(s) not in ${BASE_LOCALE} (orphaned translations):`);
      for (const k of extra) {
        console.log(`       extra: ${k}`);
      }
    }
  }

  const unknown = findMissingKeys();
  if (unknown.length > 0) {
    console.log(`  ❌  ${unknown.length} t() call(s) use a key missing from ${BASE_LOCALE}.json with no default:`);
    for (const u of unknown) console.log(`       ${u.file}:${u.line}  ${u.key}`);
    totalMissing += unknown.length;
  } else {
    console.log(`  ✅  every literal t() key exists in ${BASE_LOCALE}.json`);
  }

  const grown = await literalRegressions();
  if (grown.length > 0) {
    console.log('  ❌  untranslated UI text grew (translate it with t(), see FE-07):');
    for (const g of grown) console.log(`       ${g.file}: ${g.count} literal string(s), baseline ${g.baseline}`);
    totalMissing += grown.length;
  } else {
    console.log('  ✅  no file adds literal UI text beyond the baseline');
  }

  console.log('');

  if (totalMissing > 0) {
    console.error(`i18n coverage FAILED — ${totalMissing} missing key(s).\n`);
    process.exit(1);
  }

  console.log(`i18n coverage PASSED — all ${LOCALES.length} non-English locales are complete.\n`);
}

async function writeBaseline() {
  const counts = await countLiteralStrings();
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(LITERAL_BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`Wrote ${LITERAL_BASELINE_PATH}: ${total} literal string(s) in ${Object.keys(sorted).length} file(s).`);
}

if (process.argv.includes('--write-baseline')) await writeBaseline();
else await run();
