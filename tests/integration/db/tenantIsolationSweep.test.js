'use strict';
// =============================================================================
// TNA-37 — every GET route, signed in to organization A, asked for B's rows
// =============================================================================
// The isolation tests mocked the database, so they could only show that a
// handler sent organization_id, not that the SQL kept B's rows out, and they
// covered a handful of routes. This sweep runs against MySQL with two seeded
// organizations (realDb.js). For every GET route under /api/v1 it fills each
// path parameter with organization B's id for that resource, and calls list
// routes both bare and filtered by B's client and contract. No response may
// contain B's marker. Write routes (POST/PUT/DELETE with B's ids) are not
// swept yet: deferred, see the PR.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { describeDb, ORG_A, ORG_B, LEAK_RE, setup, teardown, relaxLimits } = require('./realDb');

// Routes that are not a single request/response.
const NOT_SWEPT = [
  /\/events\/(stream|metrics|outages)$/, // server-sent events: never end
  /\/ws(\/|$)/,
];

// Reviewed responses that contain B's marker for a reason other than a leak.
// Each needs the reason; the list starts empty.
const REVIEWED_LEAKS = {};

// Reviewed 5xx answers; any other 5xx or timeout fails the sweep.
const REVIEWED_FAILURES = {
  '/api/v1/firerelay/health': '503 by design when no FIRERELAY cluster token is configured',
};

const snake = s => s.replace(/-/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function plurals(word) {
  const w = snake(word);
  const out = [w, `${w}s`];
  if (w.endsWith('y')) out.push(`${w.slice(0, -1)}ies`);
  if (/(s|x|ch|sh)$/.test(w)) out.push(`${w}es`);
  return out;
}

// Candidate tables for a path parameter, most specific first:
// /clients/:id/contacts/:contactId → client_contacts, contacts, …
function candidates(segments, index) {
  const name = segments[index].slice(1);
  const literals = segments.slice(0, index).filter(s => s && !s.startsWith(':'));
  const out = [];
  const base = name.replace(/_?[Ii]d$/, '');
  if (base && base !== name) {
    const parent = literals.at(-2);
    if (parent) for (const p of plurals(base)) out.push(`${snake(parent).replace(/s$/, '')}_${p}`);
    out.push(...plurals(base));
  }
  const last = literals.at(-1);
  const prev = literals.at(-2);
  if (last) {
    if (prev) for (const p of plurals(last)) out.push(`${snake(prev).replace(/s$/, '')}_${p}`, `${snake(prev)}_${p}`);
    out.push(...plurals(last));
    // /billing/disputes → billing_disputes
    if (prev) out.push(`${snake(prev)}_${snake(last)}`);
  }
  return [...new Set(out)];
}

describeDb('tenant isolation against a real database', () => {
  let ctx;
  let app;
  let inventory;
  let request;

  beforeAll(async () => {
    relaxLimits();
    ctx = await setup();
    inventory = require('../../helpers/routeInventory');
    inventory.install();
    app = require('../../../src/app');
    request = require('supertest');
  }, 300000);

  afterAll(teardown);

  function idFor(table) {
    if (table === 'organizations') return ORG_B;
    if (table === 'users') return ctx.users[ORG_B];
    return ctx.seeded.get(table)?.[ORG_B]?.id;
  }

  function resolvePath(routePath) {
    const segments = routePath.split('/');
    const unresolved = [];
    const filled = segments.map((seg, i) => {
      if (!seg.startsWith(':')) return seg;
      const table = candidates(segments, i).find(t => idFor(t) !== undefined);
      if (!table) { unresolved.push(seg); return null; }
      return String(idFor(table));
    });
    return unresolved.length ? { unresolved } : { url: filled.join('/') };
  }

  async function call(method, url, token) {
    try {
      const res = await request(app)[method.toLowerCase()](url)
        .set('Authorization', `Bearer ${token}`)
        .timeout({ response: 10000, deadline: 15000 });
      const body = Buffer.isBuffer(res.body) ? res.body.toString('latin1') : (res.text ?? JSON.stringify(res.body ?? ''));
      return { status: res.status, body };
    } catch (err) {
      return { status: err.timeout ? 'timeout' : 'error', body: '' };
    }
  }

  // A small pool keeps the run short without flooding the connection pool.
  async function runAll(jobs, width = 6) {
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        results.push({ ...job, ...(await call(job.method, job.url, job.token)) });
      }
    }));
    return results;
  }

  test('the seed reached the core tables in both organizations', () => {
    for (const table of ['clients', 'contracts', 'invoices', 'payments', 'tickets', 'devices', 'plans', 'sites']) {
      expect([table, ctx.seeded.has(table)]).toEqual([table, true]);
    }
    // Reported, not asserted: which tables the generic seeder could not fill.
    console.log(`seeded ${ctx.seeded.size} tables; skipped ${ctx.skipped.size}`);
  });

  test('organization A sees its own data and none of B\'s', async () => {
    const own = await call('GET', '/api/v1/clients', ctx.staffToken(ORG_A));
    expect(own.status).toBe(200);
    expect(own.body).toMatch(/ZQXA/);
    expect(own.body).not.toMatch(LEAK_RE);
    const theirs = await call('GET', `/api/v1/clients/${idFor('clients')}`, ctx.staffToken(ORG_A));
    expect(theirs.status).toBe(404);
  });

  test('no GET route returns organization B\'s rows to organization A', async () => {
    const routes = inventory.list(app)
      .filter(r => r.method === 'GET' && r.path.startsWith('/api/v1/'))
      .filter(r => !NOT_SWEPT.some(re => re.test(r.path)));
    const staff = ctx.staffToken(ORG_A);
    const portal = ctx.portalToken(ORG_A);
    const filter = `client_id=${idFor('clients')}&contract_id=${idFor('contracts')}&clientId=${idFor('clients')}`;

    const jobs = [];
    const unresolved = [];
    for (const route of routes) {
      const token = route.path.startsWith('/api/v1/portal/') ? portal : staff;
      if (!route.path.includes(':')) {
        jobs.push({ method: 'GET', route: route.path, url: route.path, token });
        jobs.push({ method: 'GET', route: `${route.path}?<B filters>`, url: `${route.path}?${filter}`, token });
        continue;
      }
      const resolved = resolvePath(route.path);
      if (resolved.unresolved) unresolved.push(`${route.path} (${resolved.unresolved.join(', ')})`);
      else jobs.push({ method: 'GET', route: route.path, url: resolved.url, token });
    }

    const results = await runAll(jobs);
    const leaks = results
      .filter(r => LEAK_RE.test(r.body) && !REVIEWED_LEAKS[r.route])
      .map(r => `${r.route} -> ${r.status}: ${r.body.match(/.{0,80}zqxb.{0,40}/i)?.[0]}`);
    const byStatus = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

    const failed = results
      .filter(r => r.status === 'timeout' || r.status === 'error' || r.status >= 500)
      .map(r => `${r.route} -> ${r.status}`);
    const report = { requests: results.length, byStatus, failed, unresolved, leaks, skippedTables: Object.fromEntries(ctx.skipped) };
    const out = process.env.DB_INTEGRATION_REPORT || path.join(__dirname, '../../../coverage/db-isolation-report.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`swept ${results.length} requests ${JSON.stringify(byStatus)}; ${unresolved.length} parameterised routes had no seeded table; failed: ${failed.join(', ')}`);

    expect(leaks).toEqual([]);
    expect(failed.filter(f => !REVIEWED_FAILURES[f.replace(/\?<B filters>/, '').replace(/ -> .*/, '')])).toEqual([]);
    // The sweep must stay meaningful: most requests are answered, not refused
    // by authentication or rate limits.
    expect(byStatus[401] || 0).toBeLessThan(results.length * 0.05);
    expect(byStatus[429] || 0).toBe(0);
    const ok = results.filter(r => typeof r.status === 'number' && r.status < 300).length;
    expect(ok).toBeGreaterThan(results.length * 0.2);
  }, 900000);
});
