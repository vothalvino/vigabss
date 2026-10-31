// =============================================================================
// DB-23 — built-in personas can use what they are shown
// =============================================================================
// A replay of the migrations' role grants showed: technician lacked a slug
// for posting ticket comments, cpe_diagnostics.view and
// provisioning_pipelines.view; readonly's nas.health read slug also ran the
// fleet-wide NAS health-check probe. Pure file parsing — no DB, no app boot.
// =============================================================================

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'database', 'migrations');
const names = (list) => [...list.matchAll(/'([A-Za-z0-9_.]+)'/g)].map(m => m[1]);

/** role -> Set(slug), from `role_permissions` grants of the form
 *  ... JOIN permissions p ON p.name IN (...) | = '...' ... WHERE r.name IN (...) | = '...' */
function replayGrants() {
  const grants = new Map();
  const add = (role, slug) => { if (!grants.has(role)) grants.set(role, new Set()); grants.get(role).add(slug); };
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const stmt of sql.split(';')) {
      if (!/INSERT\s+IGNORE\s+INTO\s+role_permissions/i.test(stmt)) continue;
      const perm = /p\.name\s*(?:IN\s*\(([^)]*)\)|=\s*'([^']+)')/i.exec(stmt);
      const role = /r\.name\s*(?:IN\s*\(([^)]*)\)|=\s*'([^']+)')/i.exec(stmt);
      if (perm && role) {
        const slugs = perm[1] ? names(perm[1]) : [perm[2]];
        const roles = role[1] ? names(role[1]) : [role[2]];
        for (const r of roles) for (const s of slugs) add(r, s);
        continue;
      }
      // 483: every group holding tickets.update also gets tickets.comment.
      if (/pu\.name\s*=\s*'tickets\.update'/.test(stmt) && /pc\.name\s*=\s*'tickets\.comment'/.test(stmt)) {
        for (const [r, set] of grants) if (set.has('tickets.update')) add(r, 'tickets.comment');
      }
    }
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
