'use strict';
// =============================================================================
// FE-06 — every permission-guarded route refuses each built-in role that
// lacks the permission, against the real permission seed
// =============================================================================
// The e2e user was an admin AND the install operator, so no permission check
// ever ran end to end, and the mocked suites stub requirePermission. Here an
// ordinary user of each built-in group (billing, support, technician,
// readonly) calls every /api/v1 route whose guards are all requirePermission,
// with the group's real permissions from role_permissions:
//   - a role holding none of a guard's permissions must never get a success
//     or a 5xx (the write is refused, so nothing is changed);
//   - a GET the role may call that answers 403 is listed in the report: the
//     handler may add its own check, so it is not a failure by itself.
// Routes with role or channel guards are counted, not called.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9301;
const PERSONAS = ['billing', 'support', 'technician', 'readonly'];
const NOT_SWEPT = [/\/events\/(stream|metrics|outages)$/, /\/ws(\/|$)/];

describeDb('per-role permission matrix against a real database', () => {
  let db;
  let app;
  let request;
  let inventory;
  let GUARD;
  const personas = {};

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    await createOrgAdmin(db, ORG, 'RBAC');
    const bcrypt = require('bcryptjs');
    const { signStaffAccessToken } = require('../../../src/utils/accessTokens');
    const hash = await bcrypt.hash('integration-only-password', 4);
    for (const persona of PERSONAS) {
      const [[group]] = await db.query('SELECT id FROM roles WHERE name = ? AND is_system = 1 AND deleted_at IS NULL', [persona]);
      const [user] = await db.query(
        `INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, group_id, status)
         VALUES (?, ?, 'RBAC', ?, ?, ?, ?, 'active')`,
        [ORG, persona, `${persona}-${ORG}@example.com`, hash, persona, group.id],
      );
      await db.query('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)', [ORG, user.insertId, persona]);
      const [perms] = await db.query(
        'SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
        [group.id],
      );
      personas[persona] = {
        token: signStaffAccessToken({ sub: user.insertId, orgId: ORG, tv: 0 }),
        permissions: new Set(perms.map(r => r.name)),
      };
    }
    inventory = require('../../helpers/routeInventory');
    inventory.install();
    app = require('../../../src/app');
    ({ GUARD } = require('../../../src/middleware/routeGuard'));
    request = require('supertest');
  }, 120000);

  afterAll(teardown);

  test('each role is refused everything it lacks the permission for', async () => {
    const routes = inventory.list(app)
      .filter(r => r.path.startsWith('/api/v1/') && !r.path.startsWith('/api/v1/portal/'))
      .filter(r => !NOT_SWEPT.some(re => re.test(r.path)));

    const jobs = [];
    let skippedGuards = 0;
    for (const route of routes) {
      const guards = route.chain.filter(fn => fn && fn[GUARD]).map(fn => fn[GUARD]);
      if (!guards.length) continue;
      if (!guards.every(g => Array.isArray(g.permissions))) { skippedGuards++; continue; }
      const url = route.path.split('/').map(seg => (seg.startsWith(':') ? '1' : seg)).join('/');
      for (const persona of PERSONAS) {
        const { permissions } = personas[persona];
        const allowed = guards.every(g => g.permissions.some(p => permissions.has(p)));
        if (!allowed) jobs.push({ persona, method: route.method, route: route.path, url, expect: 'denied' });
        else if (route.method === 'GET') jobs.push({ persona, method: 'GET', route: route.path, url, expect: 'allowed' });
      }
    }

    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        let status;
        try {
          const req = request(app)[job.method.toLowerCase()](job.url)
            .set('Authorization', `Bearer ${personas[job.persona].token}`)
            .timeout({ response: 10000, deadline: 15000 });
          status = (job.method === 'GET' || job.method === 'DELETE' ? await req : await req.send({})).status;
        } catch (err) {
          status = err.timeout ? 'timeout' : 'error';
        }
        results.push({ ...job, status });
      }
    }));

    const denied = results.filter(r => r.expect === 'denied');
    const leaked = denied
      .filter(r => typeof r.status !== 'number' || r.status < 400 || r.status >= 500)
      .map(r => `${r.persona} ${r.method} ${r.route} -> ${r.status}`);
    const refusedAllowed = results
      .filter(r => r.expect === 'allowed' && r.status === 403)
      .map(r => `${r.persona} GET ${r.route}`);
    const deniedBy403 = denied.filter(r => r.status === 403).length;

    const report = {
      requests: results.length, denied: denied.length, deniedBy403, skippedGuards, leaked, refusedAllowed,
    };
    const out = process.env.DB_RBAC_REPORT || path.join(__dirname, '../../../coverage/db-rbac-report.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`rbac: ${results.length} requests, ${denied.length} expected refusals (${deniedBy403} as 403), ${refusedAllowed.length} allowed GETs refused, ${skippedGuards} routes with role/channel guards`);

    expect(leaked).toEqual([]);
    // The matrix must actually exercise refusals for every role.
    for (const persona of PERSONAS) expect(denied.filter(r => r.persona === persona).length).toBeGreaterThan(50);
  }, 900000);
});
