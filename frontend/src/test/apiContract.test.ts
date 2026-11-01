// =============================================================================
// VigaBSS 5.0 — Every api.<METHOD>(path) call exists in the OpenAPI spec
// =============================================================================
// The QoS & Bandwidth page saved edits with api.PATCH on eight resources whose
// routers expose only PUT (NET-14). Every Save fell through to the 404 handler,
// and the page test mocked api.PATCH, so it stayed green. The calls are typed
// `as never`, so the compiler cannot catch it either. This scans the source for
// literal method/path pairs and checks each against docs/openapi.json.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.resolve(srcDir, '../../docs/openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

// Routes that exist in Express but are missing from the spec. Shrink this list
// when documenting one; never add to it without checking the route exists.
const SPEC_GAPS = new Set([
  'GET /inventory/items',
  'GET /devices/{id}/snmp-metrics',
  'GET /dashboard/throughput',
  'GET /dashboard/live-sessions',
  'GET /dashboard/sites-utilization',
  'GET /dashboard/network-devices',
]);
// Calls with no route at all (they 404 today), tracked for a fix.
const KNOWN_MISSING_ROUTES = new Set([
  'DELETE /wireless/ap-commands/{id}',
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'test' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

function apiCalls() {
  const calls: { key: string; where: string }[] = [];
  for (const file of sourceFiles(srcDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /api\.(GET|POST|PUT|PATCH|DELETE)\(\s*['`]([^'`]+)['`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[2].includes('${')) continue;
      const line = text.slice(0, m.index).split('\n').length;
      calls.push({ key: `${m[1]} ${m[2]}`, where: `${path.relative(srcDir, file)}:${line}` });
    }
  }
  return calls;
}

describe('frontend API calls match the OpenAPI contract', () => {
  const calls = apiCalls();

  it('finds the calls it is checking', () => {
    expect(calls.length).toBeGreaterThan(100);
  });

  it('every method and path exists in docs/openapi.json', () => {
    const missing = calls
      .filter(({ key }) => {
        const [method, p] = key.split(' ');
        return !spec.paths[p]?.[method.toLowerCase()] && !SPEC_GAPS.has(key) && !KNOWN_MISSING_ROUTES.has(key);
      })
      .map(({ key, where }) => `${key}  (${where})`);
    expect(missing).toEqual([]);
  });

  it('the allow-lists only hold entries still needed', () => {
    const used = new Set(calls.map((c) => c.key));
    const stale = [...SPEC_GAPS, ...KNOWN_MISSING_ROUTES].filter((key) => {
      const [method, p] = key.split(' ');
      return !used.has(key) || Boolean(spec.paths[p]?.[method.toLowerCase()]);
    });
    expect(stale).toEqual([]);
  });

  it('the QoS & Bandwidth page saves with PUT', () => {
    const qos = calls.filter((c) => c.where.startsWith('pages/QosBandwidthPage.tsx'));
    expect(qos.some((c) => c.key.startsWith('PATCH '))).toBe(false);
    expect(qos.filter((c) => c.key.startsWith('PUT ')).length).toBeGreaterThanOrEqual(9);
  });
});
