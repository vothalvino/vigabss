'use strict';
// =============================================================================
// TNA-37 — every route, signed in to organization A, aimed at B's rows
// =============================================================================
// The isolation tests mocked the database, so they could only show that a
// handler sent organization_id, not that the SQL kept B's rows out, and they
// covered a handful of routes. This sweep runs against MySQL with two seeded
// organizations (realDb.js). For every GET route under /api/v1 it fills each
// path parameter with organization B's id for that resource, and calls list
// routes both bare and filtered by B's client and contract. No response may
// contain B's marker.
//
// Then every POST/PUT/PATCH/DELETE route is called the same way, with B's ids
// in the path and in every id field of a body built from the route's
// validation schema. After each request the sweep compares a checksum of
// every B row and counts A rows that point at B's rows: a write may neither
// change B's data nor link A's data to it, and a write addressed to B's id
// may not succeed.
//
// Every parameterised route must resolve: a parameter the name guess cannot
// place goes in PATH_PARAMS, one naming an install-wide row in INSTALL_WIDE.
//
// DB_SWEEP_LOCALE picks the organizations' locale (MX by default). CI runs
// both: as global, a route whose parameter names a Mexican table has no B
// row to aim at and is listed as MX-only instead.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { describeDb, SWEEP_LOCALE, ORG_A, ORG_B, LEAK_RE, setup, teardown, relaxLimits } = require('./realDb');

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

// Write routes not swept: sign-in and session state (a logout or a password
// change would end the sweep's session), collectors and webhooks that do not
// use a staff session, and install-level operations.
const NOT_WRITTEN = [
  /^\/api\/v1\/(auth|portal\/auth|2fa|sso)\//,
  /^\/api\/v1\/(security-admin|system|backup-settings|data-security|firerelay)\//,
  /^\/api\/v1\/(radius\/accounting|pppoe\/events|connection-logs\/cgnat-attribution\/bindings\/ingest)/,
  /^\/api\/v1\/(payment-webhooks|whatsapp\/webhook|communication\/delivery-webhook)/,
];

// Reviewed writes that answer 2xx with B's id in the path without touching
// B's data. Each needs the reason.
const REVIEWED_ACCEPTED = {
  'PUT /api/v1/support/channels/:channel':
    'the path names a channel, not a row: the upsert is keyed by the caller\'s organization and saves A\'s own config for it',
};

const quote = name => `\`${String(name).replace(/`/g, '``')}\``;
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

// Path parameters the name guess cannot place, keyed by the path up to and
// including the parameter (without /api/v1). A string names the table whose
// B id fills it; { table, column } takes that column of B's row instead; a
// { value } is a fixed name the route expects.
const PATH_PARAMS = {
  '/interactions/:id': 'client_interactions',
  '/escalations/:id': 'ticket_escalations',
  '/discovery-scans/:id/results/:resultId': 'discovery_results',
  '/trap-forwarding-rules/:id': 'snmp_trap_forwarding_rules',
  '/connection-logs/cgnat-attribution/exporters/:id': 'cgnat_exporter_configs',
  '/cfdi-documents/:id': 'cfdi_documents',
  '/cfdi/:id': 'cfdi_documents',
  '/cfdi/payment-complement/:id': 'cfdi_payment_complements',
  '/pdf/cfdi/:id': 'cfdi_documents',
  '/snii-reporting/batches/:id': 'snii_report_batches',
  '/snii-reporting/artifacts/:id': 'snii_report_artifacts',
  '/snii-reporting/filing-events/:id': 'snii_filing_events',
  '/snii-reporting/profile/applicability/:elementType': { table: 'snii_element_applicability', column: 'element_type' },
  '/facturas-publicas/:id': 'factura_publica_invoices',
  '/portal/kb/:slugOrId': 'portal_kb_articles',
  '/portal/chat/:token': { table: 'portal_chat_sessions', column: 'session_token' },
  '/olt-management/:id': 'devices',
  '/olt-management/ports/:portId': 'olt_ports',
  '/olt-management/splitters/:splitterId': 'olt_splitters',
  '/olt-management/onu-migrations/:jobId': 'onu_migration_jobs',
  '/onu-management/details/:id': 'onu_details',
  '/onu-management/profiles/:id': 'onu_profiles',
  '/onu-management/whitelist/:id': 'onu_whitelist',
  '/onu-management/omci-configs/:id': 'onu_omci_configs',
  '/onu-management/firmware-jobs/:id': 'onu_firmware_jobs',
  '/cpe-management/firmware-versions/:id': 'cpe_firmware_versions',
  '/cpe-management/firmware-campaigns/:id': 'cpe_firmware_campaigns',
  '/cpe-management/devices/:id/diagnostics/:diagId': 'cpe_diagnostics',
  '/cpe-profiles/:id/mappings/:mappingId': 'cpe_parameter_mappings',
  '/wireless/ap-sectors/:id': 'ap_sector_configs',
  '/wireless/channel-plans/:id': 'ap_channel_plans',
  '/wireless/ap-commands/:id': 'ap_command_jobs',
  '/wireless/link-planning/:id': 'link_planning_calcs',
  '/wireless/network-links/:id': 'network_links',
  '/wireless/spectrum-scans/:id': 'spectrum_scan_results',
  '/mpls-vlan-prioritization/:id': 'mpls_vlan_prioritization_rules',
  '/consumer-protection/service-modifications/:id': 'service_modification_notices',
  '/network-security/ddos-protection/:id': 'ddos_protection_rules',
  '/router-drivers/:id': 'router_driver_configs',
  '/reseller-portal/:id': 'resellers',
  '/reseller-portal/:id/clients/:cId': 'clients',
  '/support/kb/:id': 'kb_articles',
  '/support/channels/:channel': { table: 'support_channel_configs', column: 'channel' },
  '/wg-peers/:id': 'wg_user_peers',
  '/wg-peers/admin/:id': 'wg_user_peers',
  '/radius/:id/routes/:routeId': 'radius_account_routes',
  '/subscriber-certificates/radius-account/:radiusAccountId': 'radius',
  '/topology/geofences/:id': 'map_geofences',
  '/topology/infrastructure/:id': 'map_infrastructure_points',
  '/topology/dependencies/:id': 'device_dependency_edges',
  '/portal-kb/:id': 'portal_kb_articles',
  '/clients/:clientId/dnd/:channel': { value: 'email' },
  '/clients/:id/documents/:fileId': 'files',
  '/ai/phrases/:id': 'ai_phrase_library',
  '/dhcp-servers/reservations/:rid': 'dhcp_static_reservations',
  '/ipv6/ra-guard/:id': 'ra_guard_policies',
  '/transition-mechanisms/6rd/:id': 'tunnel_6rd_configs',
  '/transition-mechanisms/ds-lite/:id': 'ds_lite_configs',
  '/transition-mechanisms/464xlat/:id': 'xlat464_configs',
  '/fiber-plant/otdr/tests/:id': 'otdr_test_results',
  '/fiber-plant/sfp/:id': 'sfp_inventory',
  '/fiber-plant/fiber-routes/port/:portId': 'olt_ports',
  '/regulatory-compliance/consent/:id': 'subscriber_consents',
  '/regulatory-compliance/identity-verification/:id': 'identity_verification_records',
  '/regulatory-compliance/preservation-holds/:id': 'preservation_holds',
  '/numbering-management/phone-numbers/:id': 'phone_number_inventory',
  '/numbering-management/portability/:id': 'number_portability_records',
  '/universal-service/rural-coverage/:id': 'rural_coverage_reports',
  '/alerts/escalation-chains/:id/steps/:stepId': 'alert_escalation_steps',
  '/billing-disputes/:id/evidence/:evidenceId': 'dispute_evidence',
  '/device-config-backups/diff/:id': 'device_config_backups',
  '/sso/:orgId': 'organizations',
  '/reports/:report': { value: 'aging' },
};

// Routes whose parameter names an install-wide row, not one organization's:
// there is no B row to aim at. Each needs the reason.
const INSTALL_WIDE = {
  '/roles/:id': 'roles and their permissions are install-wide',
  '/roles/:id/permissions/:permissionId': 'roles and their permissions are install-wide',
  '/poller-nodes/:id': 'poller nodes are install infrastructure',
  '/settings/:key': 'the settings table is install-level configuration',
  '/backup-settings/download/:filename': 'backups are install-level',
  '/integrations/providers/:id': 'integration providers are an install-wide catalog',
};

describeDb(`tenant isolation against a real database (${SWEEP_LOCALE})`, () => {
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

  function paramValue(segments, i) {
    const key = segments.slice(0, i + 1).join('/').replace(/^\/api\/v1/, '');
    const mapped = PATH_PARAMS[key];
    if (mapped?.value !== undefined) return mapped.value;
    if (mapped?.table) return ctx.seeded.get(mapped.table)?.[ORG_B]?.[mapped.column];
    if (mapped) return idFor(mapped);
    const table = candidates(segments, i).find(t => idFor(t) !== undefined);
    return table && idFor(table);
  }

  // The parameter names a table a global organization cannot hold.
  function mxOnlyParam(segments, i) {
    const key = segments.slice(0, i + 1).join('/').replace(/^\/api\/v1/, '');
    const mapped = PATH_PARAMS[key];
    const tables = mapped ? [typeof mapped === 'string' ? mapped : mapped.table] : candidates(segments, i);
    return tables.some(t => ctx.mxOnly.has(t));
  }

  function resolvePath(routePath) {
    const segments = routePath.split('/');
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join('/').replace(/^\/api\/v1/, '');
      if (INSTALL_WIDE[key]) return { installWide: INSTALL_WIDE[key] };
    }
    const unresolved = [];
    let mxOnly = false;
    const filled = segments.map((seg, i) => {
      if (!seg.startsWith(':')) return seg;
      const value = paramValue(segments, i);
      if (value === undefined || value === null) {
        if (mxOnlyParam(segments, i)) mxOnly = true;
        else unresolved.push(seg);
        return null;
      }
      return encodeURIComponent(String(value));
    });
    if (unresolved.length) return { unresolved };
    return mxOnly ? { mxOnly } : { url: filled.join('/') };
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
    const mxOnlyRoutes = [];
    for (const route of routes) {
      const token = route.path.startsWith('/api/v1/portal/') ? portal : staff;
      if (!route.path.includes(':')) {
        jobs.push({ method: 'GET', route: route.path, url: route.path, token });
        jobs.push({ method: 'GET', route: `${route.path}?<B filters>`, url: `${route.path}?${filter}`, token });
        continue;
      }
      const resolved = resolvePath(route.path);
      if (resolved.installWide) continue;
      if (resolved.mxOnly) { mxOnlyRoutes.push(route.path); continue; }
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
    const report = {
      locale: SWEEP_LOCALE, requests: results.length, byStatus, failed, unresolved, mxOnly: mxOnlyRoutes, leaks,
      skippedTables: Object.fromEntries(ctx.skipped),
    };
    const out = process.env.DB_INTEGRATION_REPORT || path.join(__dirname, '../../../coverage/db-isolation-report.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`swept ${results.length} requests ${JSON.stringify(byStatus)}; ${unresolved.length} parameterised routes had no seeded table; failed: ${failed.join(', ')}`);

    expect(leaks).toEqual([]);
    // Every parameterised route is reached: a new one needs a seeded table or
    // a PATH_PARAMS entry.
    expect(unresolved).toEqual([]);
    expect(failed.filter(f => !REVIEWED_FAILURES[f.replace(/\?<B filters>/, '').replace(/ -> .*/, '')])).toEqual([]);
    // The sweep must stay meaningful: most requests are answered, not refused
    // by authentication or rate limits.
    expect(byStatus[401] || 0).toBeLessThan(results.length * 0.05);
    expect(byStatus[429] || 0).toBe(0);
    const ok = results.filter(r => typeof r.status === 'number' && r.status < 300).length;
    expect(ok).toBeGreaterThan(results.length * 0.2);
  }, 900000);

  // ---------------------------------------------------------------------------
  // Write routes
  // ---------------------------------------------------------------------------

  // An id field names its table: client_id → clients, assigned_to → users.
  function idField(field) {
    if (/^(assigned_to|created_by|user_id|technician_id|owner_id)$/.test(field)) return idFor('users');
    const base = field.replace(/(_id|Id)$/, '');
    if (base === field) return undefined;
    for (const table of plurals(base)) if (idFor(table) !== undefined) return idFor(table);
    return undefined;
  }

  // Every seeded table's B id under its *_id name, for routes that read ids
  // from the body without a declared schema.
  function bIdFields() {
    const out = {};
    for (const table of ctx.seeded.keys()) {
      const id = idFor(table);
      if (typeof id !== 'number') continue;
      const singular = table.endsWith('ies') ? `${table.slice(0, -3)}y` : table.replace(/s$/, '');
      out[`${singular}_id`] = id;
    }
    return { ...out, client_id: idFor('clients'), contract_id: idFor('contracts'), assigned_to: idFor('users') };
  }

  function sample(rules) {
    if (Array.isArray(rules.enum) && rules.enum.length) return rules.enum[0];
    switch (rules.type) {
      case 'number': return Math.max(1, Number(rules.min) || 1);
      case 'boolean': return true;
      case 'email': return 'zqxa.sweep@example.com';
      case 'array': return [];
      case 'object': return {};
      default: {
        if (rules.timestamp || /date|_at$/.test(rules.field)) return '2026-06-15';
        const text = 'ZQXA sweep value';
        const min = Number(rules.min) || 0;
        const max = Number(rules.max) || text.length;
        return text.padEnd(min, 'x').slice(0, Math.max(min, Math.min(max, text.length)));
      }
    }
  }

  // A body the route's validate() schema accepts, every id field B's.
  function bodyFor(route) {
    const schema = Object.assign({}, ...route.chain.filter(fn => fn && fn.schema).map(fn => fn.schema));
    const body = bIdFields();
    for (const [field, rules] of Object.entries(schema)) {
      const id = idField(field);
      if (id !== undefined) body[field] = id;
      else if (rules.required) body[field] = sample({ ...rules, field });
    }
    return body;
  }

  // One query: per table, the count and checksum of B's rows, and per id
  // column of A's tables, how many A rows point at B's row.
  function snapshotSql() {
    const parts = [];
    const params = [];
    for (const table of ctx.tables.values()) {
      const cols = table.columns.map(c => quote(c.c));
      const hasOrg = table.columns.some(c => c.c === 'organization_id');
      const row = `CRC32(CONCAT_WS('#', ${cols.join(', ')}))`;
      if (hasOrg) {
        parts.push(`SELECT ? AS k, COUNT(*) AS n, COALESCE(SUM(${row}), 0) AS s FROM ${quote(table.name)} WHERE organization_id = ?`);
        params.push(`b:${table.name}`, ORG_B);
        for (const [column, fk] of table.fks) {
          const target = idFor(fk.table);
          if (typeof target !== 'number' || fk.column !== 'id') continue;
          parts.push(`SELECT ?, COUNT(*), 0 FROM ${quote(table.name)} WHERE organization_id = ? AND ${quote(column)} = ?`);
          params.push(`x:${table.name}.${column}`, ORG_A, target);
        }
      } else if (ctx.seeded.get(table.name)?.[ORG_B]?.id !== undefined) {
        parts.push(`SELECT ?, COUNT(*), COALESCE(SUM(${row}), 0) FROM ${quote(table.name)} WHERE id = ?`);
        params.push(`b:${table.name}`, ctx.seeded.get(table.name)[ORG_B].id);
      }
    }
    return { sql: parts.join('\nUNION ALL\n'), params };
  }

  async function snapshot(query) {
    const [rows] = await ctx.db.query(query.sql, query.params);
    return new Map(rows.map(r => [r.k, `${r.n}:${r.s}`]));
  }

  async function write(method, url, token, body) {
    try {
      const res = await request(app)[method.toLowerCase()](url)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .timeout({ response: 10000, deadline: 15000 });
      return { status: res.status };
    } catch (err) {
      return { status: err.timeout ? 'timeout' : 'error' };
    }
  }

  test('no write route changes organization B\'s rows or links A\'s rows to them', async () => {
    const routes = inventory.list(app)
      .filter(r => r.method !== 'GET' && r.path.startsWith('/api/v1/'))
      .filter(r => !NOT_SWEPT.some(re => re.test(r.path)) && !NOT_WRITTEN.some(re => re.test(r.path)));
    const staff = ctx.staffToken(ORG_A);
    const portal = ctx.portalToken(ORG_A);
    const query = snapshotSql();
    let before = await snapshot(query);
    const initialLinks = [...before].filter(([k, v]) => k.startsWith('x:') && !v.startsWith('0:'));

    const changed = [];
    const linked = [];
    const accepted = [];
    const unresolved = [];
    const installWide = [];
    const mxOnlyRoutes = [];
    const byStatus = {};
    // Deletes last, so the other writes still find B's rows.
    const order = { POST: 0, PUT: 1, PATCH: 1, DELETE: 2 };
    routes.sort((a, b) => order[a.method] - order[b.method]);

    // One at a time: each change is attributed to the request that made it.
    for (const route of routes) {
      const token = route.path.startsWith('/api/v1/portal/') ? portal : staff;
      const resolved = route.path.includes(':') ? resolvePath(route.path) : { url: route.path };
      if (resolved.installWide) { installWide.push(`${route.method} ${route.path}`); continue; }
      if (resolved.mxOnly) { mxOnlyRoutes.push(`${route.method} ${route.path}`); continue; }
      if (resolved.unresolved) { unresolved.push(`${route.method} ${route.path} (${resolved.unresolved.join(', ')})`); continue; }
      const key = `${route.method} ${route.path}`;
      const { status } = await write(route.method, resolved.url, token, bodyFor(route));
      byStatus[status] = (byStatus[status] || 0) + 1;
      const after = await snapshot(query);
      for (const [k, v] of after) {
        if (before.get(k) === v) continue;
        if (k.startsWith('b:')) changed.push(`${key} -> ${status}: changed ${k.slice(2)}`);
        else if (Number(v.split(':')[0]) > Number((before.get(k) || '0:').split(':')[0])) linked.push(`${key} -> ${status}: ${k.slice(2)} now points at B`);
      }
      if (route.path.includes(':') && typeof status === 'number' && status < 300 && !REVIEWED_ACCEPTED[key]) {
        accepted.push(`${key} -> ${status}`);
      }
      before = after;
    }

    const report = {
      locale: SWEEP_LOCALE,
      requests: routes.length - unresolved.length - installWide.length - mxOnlyRoutes.length,
      byStatus, changed, linked, accepted, unresolved, installWide, mxOnly: mxOnlyRoutes, initialLinks,
    };
    const out = process.env.DB_INTEGRATION_REPORT
      ? process.env.DB_INTEGRATION_REPORT.replace(/\.json$/, '-writes.json')
      : path.join(__dirname, '../../../coverage/db-isolation-writes-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`swept ${report.requests} writes ${JSON.stringify(byStatus)}; ${unresolved.length} unresolved`);

    // One comparison, so a failing run reports every kind of finding.
    expect({ initialLinks, changed, linked, accepted, unresolved }).toEqual({
      initialLinks: [], changed: [], linked: [], accepted: [], unresolved: [],
    });
    // The sweep must stay meaningful: the session survives to the end.
    expect((await call('GET', '/api/v1/clients', staff)).status).toBe(200);
    expect(byStatus[401] || 0).toBeLessThan(routes.length * 0.05);
  }, 1800000);
});
