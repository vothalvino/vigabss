// =============================================================================
// VigaBSS — i18n key usage scanner (FE-07)
// =============================================================================
// Finds t('literal.key') calls whose key is missing from en.json and that pass
// no default, so i18next renders the raw key path in every locale. Used by
// scripts/i18n-coverage.mjs and src/test/i18n.test.ts.
//
// A call counts as having a default when its second argument is a string or
// an object with defaultValue. A plural call (count) resolves through the
// key_one/key_other forms; a key naming a catalogue object (returnObjects) is
// present when any key lies under it. Keys built at run time (template
// literals, variables) are not checked.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(FRONTEND_DIR, 'src');
const EN_PATH = join(SRC_DIR, 'i18n', 'locales', 'en.json');

export function flatten(obj, prefix = '') {
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

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'test') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const CALL = /(?<![\w.$])(?:i18n\.)?t\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*([,)])/g;

function hasDefault(src, after) {
  const rest = src.slice(after, after + 400).trimStart();
  if (/^['"`]/.test(rest)) return true;
  if (!rest.startsWith('{')) return false;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}' && --depth === 0) return /\bdefaultValue\s*:/.test(rest.slice(0, i));
  }
  return /\bdefaultValue\s*:/.test(rest);
}

function isPresent(key, keys, prefixes) {
  return keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`) || prefixes.has(key);
}

/** @returns {{ file: string, line: number, key: string }[]} */
export function findMissingKeys() {
  const keys = new Set(Object.keys(flatten(JSON.parse(readFileSync(EN_PATH, 'utf-8')))));
  const prefixes = new Set();
  for (const k of keys) {
    const parts = k.split('.');
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('.'));
  }
  const missing = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf-8');
    if (!/\bt\(/.test(src)) continue;
    for (const m of src.matchAll(CALL)) {
      const key = m[2];
      if (isPresent(key, keys, prefixes)) continue;
      if (m[3] === ',' && hasDefault(src, m.index + m[0].length)) continue;
      missing.push({ file: relative(FRONTEND_DIR, file), line: src.slice(0, m.index).split('\n').length, key });
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Literal UI strings
// ---------------------------------------------------------------------------
// Counts English text written straight into JSX: text children and the
// user-visible attributes below when given a string literal. The ratchet
// (scripts/i18n-literal-baseline.json) lets no file add more; translating a
// page lowers its entry. A text is counted when it has two letters in a row,
// so punctuation, symbols and single units are not.

const VISIBLE_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label']);
const WORDY = /\p{L}{2}/u;

export async function countLiteralStrings() {
  const ts = (await import('typescript')).default;
  const counts = {};
  for (const file of sourceFiles(SRC_DIR)) {
    if (!file.endsWith('.tsx')) continue;
    const src = readFileSync(file, 'utf-8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    let n = 0;
    const visit = (node) => {
      if (ts.isJsxText(node) && WORDY.test(node.text)) n++;
      else if (ts.isJsxAttribute(node) && node.initializer && VISIBLE_ATTRS.has(node.name.getText(sf))) {
        const init = node.initializer;
        const lit = ts.isStringLiteral(init) ? init
          : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) ? init.expression : null;
        if (lit && WORDY.test(lit.text)) n++;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n > 0) counts[relative(FRONTEND_DIR, file)] = n;
  }
  return counts;
}

export const LITERAL_BASELINE_PATH = join(FRONTEND_DIR, 'scripts', 'i18n-literal-baseline.json');

/** Files whose literal count rose above the baseline. */
export async function literalRegressions() {
  const baseline = JSON.parse(readFileSync(LITERAL_BASELINE_PATH, 'utf-8'));
  const counts = await countLiteralStrings();
  return Object.entries(counts)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, n]) => ({ file, count: n, baseline: baseline[file] ?? 0 }));
}
