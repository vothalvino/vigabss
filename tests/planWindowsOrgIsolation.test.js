// =============================================================================
// VigaBSS 5.0 — Plan speed/access windows: organization isolation (TNB-04/22)
// =============================================================================
// POST /plans/:id/speed-windows and /access-windows used to INSERT a window
// for any plan id (stamped with the caller's org), and every consumer keyed on
// plan_id alone — so one tenant could throttle or time-block another tenant's
// subscribers. The PUT read-back selected the window by id alone, returning a
// foreign tenant's row when the org-scoped UPDATE matched nothing. These tests
// drive the real routers against a database mock (plan 2004 lives in org 2),
// then check that each consumer ignores a window whose organization differs
// from its plan's.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

// The caller is an ordinary (non-global) user in whatever org the token names.
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin',
    membershipRole: 'admin',
    organizationId: Number(organizationId),
    isInstallOperator: false,
    isSuperAdmin: false,
    hasGlobalOrganizationAccess: false,
  })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const speedWindowService = require('../src/services/speedWindowService');
const { syncFreeradiusTables } = require('../src/services/radiusService');
const app = require('../src/app');

const ATTACKER_ORG = 1;
const VICTIM_ORG = 2;
const VICTIM_PLAN = 2004;
const VICTIM_WINDOW = 7001; // org 2's own window on plan 2004

const token = (orgId) => jwt.sign(
  { sub: 50, email: 'staff@isp.example', role: 'admin', orgId },
  config.jwt.secret,
  { expiresIn: 900, algorithm: config.jwt.algorithm },
);

let granted;
let writes;
let plans;
let speedWindows;
let accessWindows;

// Mirrors MySQL `a <=> b` (null-safe equality).
const nullSafeEq = (a, b) => (a ?? null) === (b ?? null);

// Applies the plan/window org join only when the SQL carries it, as MySQL would.
function windowsFor(table, sql, planIds) {
  const rows = table === 'speed' ? speedWindows : accessWindows;
  const joined = /w\.organization_id <=> p\.organization_id/.test(sql);
  return rows.filter((w) => planIds.map(Number).includes(w.plan_id)
    && !w.deleted_at
    && (!joined || nullSafeEq(w.organization_id, plans.find((p) => p.id === w.plan_id)?.organization_id)));
}

function dbMock(sql, params = []) {
  if (/FROM `?users`?\b/.test(sql)) {
    return [[{ id: 50, email: 'staff@isp.example', role: 'admin', status: 'active', organization_id: ATTACKER_ORG }]];
  }
  // Plan.findById(id, orgId)
  if (/^SELECT \* FROM `plans` WHERE id = \?/.test(sql)) {
    const scoped = /organization_id = \?/.test(sql);
    const row = plans.find((p) => p.id === Number(params[0]));
    return [[...(row && (!scoped || row.organization_id === params[1]) ? [row] : [])]];
  }
  if (/^\s*(INSERT INTO|UPDATE) plan_(speed|access)_windows/.test(sql)) {
    writes.push({ sql, params });
    // The PUT's UPDATE is org-scoped, so a foreign window matches nothing.
    if (/^\s*UPDATE/.test(sql)) return [{ affectedRows: params.includes(VICTIM_ORG) ? 1 : 0 }];
    return [{ insertId: 9000 }];
  }
  // Route read-backs: SELECT * FROM plan_*_windows WHERE id = ? [AND plan_id/org]
  const readBack = /^SELECT \* FROM plan_(speed|access)_windows WHERE id = \?/.exec(sql);
  if (readBack) {
    const rows = readBack[1] === 'speed' ? speedWindows : accessWindows;
    const row = rows.find((w) => w.id === Number(params[0]));
    const scoped = /organization_id = \?/.test(sql);
    if (Number(params[0]) === 9000) return [[{ id: 9000 }]];
    return [[...(row && (!scoped || row.organization_id === params[2]) ? [row] : [])]];
  }
  // applySpeedWindows: plans that have speed windows
  if (/FROM plans p\s+JOIN plan_speed_windows w/.test(sql)) {
    const orgFilter = /AND p\.organization_id = \?/.test(sql) ? params[0] : undefined;
    const ids = [...new Set(windowsFor('speed', sql, plans.map((p) => p.id)).map((w) => w.plan_id))];
    return [plans.filter((p) => ids.includes(p.id) && (orgFilter === undefined || p.organization_id === orgFilter))];
  }
  // getActiveWindow
  if (/FROM plan_speed_windows/.test(sql)) return [windowsFor('speed', sql, [params[0]]).slice(0, 1)];
  // radiusService access-window load
  if (/FROM plan_access_windows/.test(sql)) return [windowsFor('access', sql, params)];
  if (/FROM radius r/.test(sql) && /LEFT JOIN contracts/.test(sql)) {
    return [[{
      id: 1, username: 'victim@isp.net', cleartext_password: 'x', auth_method: 'pppoe',
      organization_id: VICTIM_ORG, plan_id: VICTIM_PLAN, plan_sim_use: 1,
      download_speed_mbps: 100, upload_speed_mbps: 50, plan_name: 'Victim 100M',
    }]];
  }
  if (/^\s*SELECT/i.test(sql)) return [[]];
  return [{ affectedRows: 1 }];
}

beforeEach(() => {
  jest.clearAllMocks();
  granted = [];
  writes = [];
  plans = [{ id: VICTIM_PLAN, organization_id: VICTIM_ORG, download_speed_mbps: 100, upload_speed_mbps: 50 }];
  speedWindows = [{ id: VICTIM_WINDOW, plan_id: VICTIM_PLAN, organization_id: VICTIM_ORG, label: 'Victim night', download_speed_mbps: 200, upload_speed_mbps: 100 }];
  accessWindows = [{ id: VICTIM_WINDOW, plan_id: VICTIM_PLAN, organization_id: VICTIM_ORG, label: 'Victim hours', day_mask: 127, start_time: '00:00:00', end_time: '23:59:59', status: 'active' }];
  jest.spyOn(User, 'getPermissions').mockImplementation(async () => granted);
  db.query.mockImplementation(async (sql, params) => dbMock(sql, params));
  db.getConnection.mockResolvedValue({
    beginTransaction: jest.fn(), execute: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  });
});

afterEach(() => jest.restoreAllMocks());

const speedBody = { label: 'Throttle', start_time: '00:00:00', end_time: '23:59:59', download_speed_mbps: 1, upload_speed_mbps: 1, priority: 1 };
const accessBody = { label: 'Blackout', day_mask: 1, start_time: '03:00:00', end_time: '03:01:00' };

describe('POST windows onto another organization\'s plan', () => {
  test('speed window: 404 and nothing is inserted', async () => {
    granted = ['plans.create'];
    const res = await request(app)
      .post(`/api/v1/plans/${VICTIM_PLAN}/speed-windows`)
      .set('Authorization', `Bearer ${token(ATTACKER_ORG)}`)
      .send(speedBody);
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  test('access window: 404 and nothing is inserted', async () => {
    granted = ['plan_access_windows.create'];
    const res = await request(app)
      .post(`/api/v1/plans/${VICTIM_PLAN}/access-windows`)
      .set('Authorization', `Bearer ${token(ATTACKER_ORG)}`)
      .send(accessBody);
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  test('the owning organization can still add both window kinds', async () => {
    granted = ['plans.create', 'plan_access_windows.create'];
    const speed = await request(app)
      .post(`/api/v1/plans/${VICTIM_PLAN}/speed-windows`)
      .set('Authorization', `Bearer ${token(VICTIM_ORG)}`)
      .send(speedBody);
    const access = await request(app)
      .post(`/api/v1/plans/${VICTIM_PLAN}/access-windows`)
      .set('Authorization', `Bearer ${token(VICTIM_ORG)}`)
      .send(accessBody);
    expect(speed.status).toBe(201);
    expect(access.status).toBe(201);
    expect(writes).toHaveLength(2);
  });
});

describe('PUT read-back does not return another organization\'s window', () => {
  test.each([
    ['speed-windows', 'plans.update', speedBody, 'Victim night'],
    ['access-windows', 'plan_access_windows.update', accessBody, 'Victim hours'],
  ])('%s: foreign window id gets 404 without its data', async (kind, slug, body, victimLabel) => {
    granted = [slug];
    const res = await request(app)
      .put(`/api/v1/plans/${VICTIM_PLAN}/${kind}/${VICTIM_WINDOW}`)
      .set('Authorization', `Bearer ${token(ATTACKER_ORG)}`)
      .send(body);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(victimLabel);
  });

  test('the owning organization gets its updated window back', async () => {
    granted = ['plans.update'];
    const res = await request(app)
      .put(`/api/v1/plans/${VICTIM_PLAN}/speed-windows/${VICTIM_WINDOW}`)
      .set('Authorization', `Bearer ${token(VICTIM_ORG)}`)
      .send(speedBody);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(VICTIM_WINDOW);
  });
});

describe('consumers ignore a window whose organization differs from its plan', () => {
  // A window that slipped in before the route fix: org 1 stamped onto org 2's plan.
  const plantForeignWindows = () => {
    speedWindows = [{ id: 8001, plan_id: VICTIM_PLAN, organization_id: ATTACKER_ORG, label: 'Throttle', download_speed_mbps: 1, upload_speed_mbps: 1 }];
    accessWindows = [{ id: 8002, plan_id: VICTIM_PLAN, organization_id: ATTACKER_ORG, day_mask: 1, start_time: '03:00:00', end_time: '03:01:00', status: 'active' }];
  };

  test('getActiveWindow returns null for a cross-org window', async () => {
    plantForeignWindows();
    expect(await speedWindowService.getActiveWindow(VICTIM_PLAN)).toBeNull();
  });

  test('getActiveWindow still matches same-org and NULL-org (single-tenant) windows', async () => {
    expect((await speedWindowService.getActiveWindow(VICTIM_PLAN)).id).toBe(VICTIM_WINDOW);
    plans = [{ id: VICTIM_PLAN, organization_id: null }];
    speedWindows = [{ id: 5, plan_id: VICTIM_PLAN, organization_id: null }];
    expect((await speedWindowService.getActiveWindow(VICTIM_PLAN)).id).toBe(5);
  });

  test('the global applySpeedWindows sweep never picks up a cross-org window', async () => {
    plantForeignWindows();
    const summary = await speedWindowService.applySpeedWindows(null);
    expect(summary.plans_checked).toBe(0);
    expect(summary.transitions).toBe(0);
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('FreeRADIUS sync emits no Login-Time from a cross-org access window', async () => {
    plantForeignWindows();
    await syncFreeradiusTables(null);
    const loginTime = db.query.mock.calls.find(([sql, params]) => /INSERT INTO radgroupcheck/.test(sql) && params?.[1] === 'Login-Time');
    expect(loginTime).toBeUndefined();
  });

  test('FreeRADIUS sync still emits Login-Time from the plan\'s own access window', async () => {
    accessWindows = [{ id: 1, plan_id: VICTIM_PLAN, organization_id: VICTIM_ORG, day_mask: 62, start_time: '08:00:00', end_time: '18:00:00', status: 'active' }];
    await syncFreeradiusTables(null);
    const loginTime = db.query.mock.calls.find(([sql, params]) => /INSERT INTO radgroupcheck/.test(sql) && params?.[1] === 'Login-Time');
    expect(loginTime).toBeDefined();
    expect(loginTime[1][3]).toBe('Wk0800-1800');
  });
});
