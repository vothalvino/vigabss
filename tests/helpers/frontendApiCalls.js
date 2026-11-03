'use strict';
// =============================================================================
// Every API call the frontend makes, as METHOD + path pattern (FE2-13)
// =============================================================================
// Reads frontend/src for apiFetch, authedFetch, portalApiFetch,
// portalAuthedFetch, fetch and the typed client (api.GET('/x/{id}')). A
// template segment `${id}` becomes ':param'; a leading `${API_BASE}` is
// resolved from the file's own `const API_BASE = '…'`. Query strings and an
// interpolation glued to the end of a segment (`/clients${qs}`) are dropped.
// Calls whose path is not a literal or template are returned as dynamic.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'frontend', 'src');

const CALL = /\b(apiFetch|authedFetch|portalApiFetch|portalAuthedFetch|fetch|api\.(GET|POST|PUT|PATCH|DELETE))\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(/g;
const QUERY_NAME = /(qs|query|params|search|filter|suffix)\b|\?/i;
const PREFIX = { apiFetch: '/api/v1', portalApiFetch: '/api/v1/portal', 'api.': '/api/v1' };

function files(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') files(p, out); continue; }
    if (/\.(ts|tsx)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// The argument text of a call starting at `open` (the '('), balanced. A
// `${…}` inside a template literal is code until its closing brace.
function args(src, open) {
  const stack = []; // ')', ']', '}' for code; '`}' for a template interpolation
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (quote === '`' && ch === '$' && src[i + 1] === '{') { stack.push('`}'); quote = null; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '{') stack.push('}');
    else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (top === '`}') { quote = '`'; continue; }
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

// The first argument when it is a string or template literal.
function firstLiteral(text) {
  const m = /^\s*(['"`])/.exec(text);
  if (!m) return null;
  const q = m[1];
  let i = m.index + m[0].length;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { out += text[i + 1]; i += 2; continue; }
    if (q === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth) { if (text[j] === '{') depth++; if (text[j] === '}') depth--; j++; }
      out += `\${${text.slice(i + 2, j - 1)}}`;
      i = j;
      continue;
    }
    if (ch === q) return { value: out, rest: text.slice(i + 1) };
    out += ch;
    i++;
  }
  return null;
}

function constants(src) {
  const out = {};
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/[^'"`$]*)\2/g)) out[m[1]] = m[3];
  return out;
}

function normalise(raw, kind, consts) {
  let p = raw.replace(/^\$\{([A-Za-z_$][\w$]*)\}/, (whole, name) => (name in consts ? consts[name] : whole));
  if (p.startsWith('${')) return null;
  p = p.split('?')[0];
  if (kind.startsWith('api.')) p = PREFIX['api.'] + p.replace(/(?<!\$)\{[^}]+\}/g, ':param');
  else if (PREFIX[kind] && !(kind === 'apiFetch' && p.startsWith('/api/'))) p = PREFIX[kind] + p;
  if (!p.startsWith('/api/')) return null;
  const segments = p.split('/').map(seg => {
    if (/^\$\{[^}]*\}$/.test(seg)) return ':param';
    // `/clients${qs}`: an interpolation glued to a segment is a query suffix
    // when it is named like one; `${API_BASE}${path}` is a run-time path.
    return seg.replace(/\$\{([^}]*)\}$/, (whole, expr) => (QUERY_NAME.test(expr) ? '' : whole));
  });
  if (segments.some(seg => seg.includes('${'))) return null;
  return segments.join('/').replace(/\/+$/, '') || '/';
}

function collect() {
  const calls = [];
  const dynamic = [];
  for (const file of files(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const consts = constants(src);
    const rel = path.relative(ROOT, file);
    for (const m of src.matchAll(CALL)) {
      const kind = m[2] ? `api.${m[2]}` : m[1];
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition itself
      const text = args(src, m.index + m[0].length - 1);
      const lit = firstLiteral(text);
      const line = src.slice(0, m.index).split('\n').length;
      if (!lit) { dynamic.push(`${rel}:${line}`); continue; }
      const p = normalise(lit.value, kind, consts);
      if (!p) { if (/^\$\{|^\/api\//.test(lit.value)) dynamic.push(`${rel}:${line}`); continue; }
      const method = m[2] || (/\bmethod\s*:\s*['"`](\w+)['"`]/.exec(lit.rest)?.[1] || 'GET').toUpperCase();
      calls.push({ method, path: p, where: `${rel}:${line}` });
    }
  }
  return { calls, dynamic };
}

module.exports = { collect, normalise };
