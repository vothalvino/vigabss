// =============================================================================
// DB-23 — built-in personas can use what they are shown
// =============================================================================
// A replay of the seeded role grants showed: technician lacked a slug
// for posting ticket comments, cpe_diagnostics.view and
// provisioning_pipelines.view; readonly's nas.health read slug also ran the
// fleet-wide NAS health-check probe. Pure file parsing — no DB, no app boot.
// =============================================================================

const fs = require('fs');
const path = require('path');

const { baselineRows } = require('./helpers/baseline');

const names = (list) => [...list.matchAll(/'([A-Za-z0-9_.]+)'/g)].map(m => m[1]);

/** role -> Set(slug): the role grants a fresh install has (the baseline's). */
function replayGrants() {
  const roles = new Map(baselineRows('roles').map(r => [r.id, r.name]));
  const slugs = new Map(baselineRows('permissions').map(p => [p.id, p.name]));
  const grants = new Map();
  for (const { role_id: roleId, permission_id: permissionId } of baselineRows('role_permissions')) {
    const role = roles.get(roleId);
    if (!grants.has(role)) grants.set(role, new Set());
    grants.get(role).add(slugs.get(permissionId));
  }
  return grants;
}

const grants = replayGrants();
const holds = (role, slug) => Boolean(grants.get(role)?.has(slug));
const routeSlugs = (file, pattern) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', file), 'utf8');
  const line = src.split('\n').find(l => pattern.test(l));
  return names(line.slice(line.indexOf(',')));
};

test('technician can post on a ticket it can see', () => {
  const needed = routeSlugs('tickets.js', /router\.post\('\/:id\/comments'/);
  expect(holds('technician', 'tickets.view')).toBe(true);
  expect(needed.some(s => holds('technician', s))).toBe(true);
});

test('every group that could comment before still can', () => {
  const needed = routeSlugs('tickets.js', /router\.post\('\/:id\/comments'/);
  for (const [role, set] of grants) {
    if (set.has('tickets.update')) expect(needed.some(s => holds(role, s))).toBe(true);
  }
});

test.each(['cpe_diagnostics.view', 'provisioning_pipelines.view'])('technician holds %s', (slug) => {
  expect(holds('technician', slug)).toBe(true);
});

test('the NAS health-check probe is not open to readonly, and is to technician and noc_operator', () => {
  const needed = routeSlugs('nas.js', /router\.post\('\/:id\/health-check'/);
  expect(needed).toEqual(['nas.health_check']);
  expect(holds('readonly', 'nas.health')).toBe(true);
  expect(needed.some(s => holds('readonly', s))).toBe(false);
  for (const role of ['admin', 'technician', 'noc_operator']) {
    expect(needed.some(s => holds(role, s))).toBe(true);
  }
});
