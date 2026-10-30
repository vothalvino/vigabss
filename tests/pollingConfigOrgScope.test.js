'use strict';
// =============================================================================
// VigaBSS 5.0 — Polling configs only apply inside their own org (TNA-18)
// =============================================================================
// The live poller runs install-wide, but device_polling_configs rows belong to
// an organization. getPollingConfig used to look them up by device_id or
// device_type alone, so a tenant-A type-level row
// {device_type:'router', poll_interval_sec:86400} slowed every tenant's routers
// to one poll a day, and an override naming a foreign device_id throttled that
// device. The create/update routes also stored any device_id.
//
// The db double below behaves like the real table: it holds a FOREIGN row and
// only filters it out when the emitted SQL actually carries the org predicate,
// so an unscoped lookup returns the foreign config exactly as MySQL would.
// =============================================================================

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/eventBus', () => ({
  emit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(), off: jest.fn(), once: jest.fn(), removeListener: jest.fn(),
}));
jest.mock('../src/services/snmpPoller', () => ({ pollDevice: jest.fn() }));
jest.mock('../src/services/deviceStatusService', () => ({ recordPollResult: jest.fn() }));

const config = require('../src/config');
const db = require('../src/config/database');
const pollerEngine = require('../src/services/pollerEngine');

// Org-1 device 42 (a router) and org-2 device 77.
const DEVICES = {
  42: { id: 42, type: 'router', snmp_profile_id: null, organization_id: 1 },
  77: { id: 77, type: 'router', snmp_profile_id: null, organization_id: 2 },
};

// Org 2's configs: a type-level "router" row and an override aimed at org 1's device.
const CONFIGS = [
  { id: 5, organization_id: 2, device_id: null, device_type: 'router', poll_interval_sec: 86400 },
  { id: 6, organization_id: 2, device_id: 42, device_type: null, poll_interval_sec: 86400, adaptive_polling_enabled: 1, adaptive_min_interval_sec: 3600 },
];

function wirePoller() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM devices WHERE id = \?/.test(sql)) {
      const d = DEVICES[params[0]];
      return [d ? [d] : []];
    }
    if (/FROM device_polling_configs dpc/.test(sql) && /dpc\.device_id = \?/.test(sql)) {
      const device = DEVICES[params[0]];
      let rows = CONFIGS.filter((c) => c.device_id === params[0] && device);
      if (/dpc\.organization_id <=> d\.organization_id/.test(sql)) {
        rows = rows.filter((c) => c.organization_id === device.organization_id);
      }
      return [rows];
    }
    if (/FROM device_polling_configs/.test(sql) && /device_type = \?/.test(sql)) {
      let rows = CONFIGS.filter((c) => c.device_id === null && c.device_type === params[0]);
      if (/organization_id <=> \?/.test(sql)) {
        rows = rows.filter((c) => c.organization_id === params[1] || c.organization_id === null);
      }
      return [rows];
    }
    if (/FROM outages/.test(sql)) return [[{ device_id: 42 }]];
    if (/FROM device_polling_configs/.test(sql) && /device_id IN/.test(sql)) {
      let rows = CONFIGS.filter((c) => params.includes(c.device_id) && c.adaptive_polling_enabled);
      if (/organization_id <=> d\.organization_id/.test(sql)) {
        rows = rows.filter((c) => c.organization_id === DEVICES[c.device_id].organization_id);
      }
      return [rows];
    }
    return [[]];
  });
}

beforeEach(() => { jest.clearAllMocks(); wirePoller(); });

describe('pollerEngine.getPollingConfig ignores other tenants\' configs', () => {
  it('a foreign type-level row does not throttle this org\'s routers', async () => {
    const cfg = await pollerEngine.getPollingConfig(42);
    expect(cfg.poll_interval_sec).toBe(300);
  });

  it('a foreign override naming this org\'s device is ignored', async () => {
    const cfg = await pollerEngine.getPollingConfig(42);
    expect(cfg.id).not.toBe(6);
  });

  it('the owning org\'s type-level row still applies to its own devices', async () => {
    const cfg = await pollerEngine.getPollingConfig(77);
    expect(cfg.id).toBe(5);
    expect(cfg.poll_interval_sec).toBe(86400);
  });

  it('adaptive overrides only come from a config in the device\'s org', async () => {
    const result = await pollerEngine.adaptivePollCheck();
    expect(result.adaptiveOverridesActive).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Route: device_id must be a device of the caller's org
// ---------------------------------------------------------------------------
const app = require('../src/app');

const ADMIN = { id: 1, email: 'a@b.c', role: 'admin', status: 'active', organization_id: 1 };
const token = () => jwt.sign({ sub: 1, email: 'a@b.c', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const auth = (r) => r.set('Authorization', `Bearer ${token()}`);

function wireRoutes() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (typeof sql === 'string' && sql.includes('`users`')) return [[ADMIN]];
    if (/SELECT id FROM devices/.test(sql)) {
      const d = DEVICES[params[0]];
      return [d && d.organization_id === params[1] ? [{ id: d.id }] : []];
    }
    if (/^INSERT INTO `?device_polling_configs`?/i.test(sql)) return [{ insertId: 900, affectedRows: 1 }];
    if (/FROM `?device_polling_configs`?/i.test(sql)) {
      return [[{ id: 900, organization_id: 1, device_id: 42, poll_interval_sec: 600 }]];
    }
    if (/^UPDATE `?device_polling_configs`?/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
  db.execute.mockImplementation(db.query.getMockImplementation());
}

describe('device polling config routes verify device_id ownership', () => {
  beforeEach(() => wireRoutes());

  it('POST with another tenant\'s device_id is a 422 and inserts nothing', async () => {
    const res = await auth(request(app).post('/api/v1/device-polling-configs'))
      .send({ device_id: 77, poll_interval_sec: 86400 });
    expect(res.status).toBe(422);
    const inserts = db.query.mock.calls.filter(([s]) => /^INSERT INTO `?device_polling_configs`?/i.test(s));
    expect(inserts).toHaveLength(0);
  });

  it('PUT moving a config onto another tenant\'s device is a 422', async () => {
    const res = await auth(request(app).put('/api/v1/device-polling-configs/900'))
      .send({ device_id: 77 });
    expect(res.status).toBe(422);
    const updates = db.query.mock.calls.filter(([s]) => /^UPDATE `?device_polling_configs`?/i.test(s));
    expect(updates).toHaveLength(0);
  });

  it('POST with an own device_id is accepted', async () => {
    const res = await auth(request(app).post('/api/v1/device-polling-configs'))
      .send({ device_id: 42, poll_interval_sec: 600 });
    expect(res.status).toBe(201);
  });
});
