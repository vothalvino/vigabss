'use strict';
// =============================================================================
// Phase 1 TNA-09 / TNB-12 — body foreign keys must belong to the caller's org
// =============================================================================
// The database FKs only prove a referenced row EXISTS. Before these fixes an
// org-A user could store org B's client/device/asset/warehouse/inventory item
// id on an org-A row; display joins then returned org B's client names and
// emails, and RMA/PO side effects mutated org B's assets and stock.
//
// World: the caller is org 1. Ids >= 900 belong to org 2 (foreign).
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, organizationId: 1, organization_id: 1, email: 'a@b.c', role: 'admin' };
    next();
  },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/middleware/ipAllowlist', () => ({
  ...jest.requireActual('../src/middleware/ipAllowlist'),
  createIpAllowlist: () => (_req, _res, next) => next(),
  parseAllowlist: () => [],
}));
jest.mock('../src/middleware/adminIpAllowlist', () => ({
  enforceAdminIpAllowlist: (_req, _res, next) => next(),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const app = require('../src/app');
const Asset = require('../src/models/Asset');
const PurchaseOrder = require('../src/models/PurchaseOrder');
const { assertOwnedReferences } = require('../src/utils/ownedReferences');

const FOREIGN = 900;
const OWN_LOOKUP = /^SELECT id FROM (\w+) WHERE id = \? AND /;

function ownershipAnswer(sql, params) {
  const m = OWN_LOOKUP.exec(sql);
  if (!m) return null;
  return [Number(params[0]) >= FOREIGN ? [] : [{ id: params[0] }]];
}

function wire(extra = () => null) {
  db.query.mockImplementation(async (sql, params = []) => {
    const own = ownershipAnswer(sql, params);
    if (own) return own;
    const r = extra(sql, params);
    if (r) return r;
    if (/^\s*INSERT/i.test(sql)) return [{ insertId: 77, affectedRows: 1 }];
    if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: 1 }];
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
    return [[]];
  });
  db.execute.mockImplementation(db.query.getMockImplementation());
}

const writes = (re) => db.query.mock.calls.filter(([s]) => re.test(s));

beforeEach(() => { jest.clearAllMocks(); });

// ---------------------------------------------------------------------------
describe('assertOwnedReferences helper', () => {
  beforeEach(() => wire());

  it('rejects a foreign id with a 422 ValidationError', async () => {
    await expect(assertOwnedReferences({ client_id: FOREIGN }, 1, { client_id: 'clients' }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('skips absent and null fields', async () => {
    await assertOwnedReferences({ client_id: null }, 1, { client_id: 'clients', device_id: 'devices' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('binds the org null-safely and only admits shared rows when asked', async () => {
    await assertOwnedReferences({ device_id: 5 }, 1, { device_id: 'devices' });
    await assertOwnedReferences({ device_id: 5 }, 1, { device_id: { table: 'devices', allowShared: true } });
    expect(db.query.mock.calls[0][0]).toMatch(/organization_id <=> \? AND deleted_at IS NULL/);
    expect(db.query.mock.calls[0][0]).not.toMatch(/IS NULL\)/);
    expect(db.query.mock.calls[1][0]).toMatch(/\(organization_id <=> \? OR organization_id IS NULL\)/);
    expect(db.query.mock.calls[0][1]).toEqual([5, 1]);
  });

  it('refuses an unscoped call and a non-allowlisted table', async () => {
    await expect(assertOwnedReferences({ a: 1 }, undefined, { a: 'clients' })).rejects.toThrow(/requires an orgId/);
    await expect(assertOwnedReferences({ a: 1 }, 1, { a: 'users; DROP' })).rejects.toThrow(/not allowlisted/);
  });
});

// ---------------------------------------------------------------------------
describe('assets (TNA-09)', () => {
  const asset = { id: 3, organization_id: 1, lifecycle_status: 'in_stock', deleted_at: null };
  const assetRows = (sql) => (/FROM `?assets`? WHERE id = \?/.test(sql) ? [[asset]] : null);

  it('POST /assets/:id/assign rejects another org\'s client_id and writes nothing', async () => {
    wire(assetRows);
    const res = await request(app).post('/api/v1/assets/3/assign').send({ client_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO asset_assignments/)).toHaveLength(0);
    expect(writes(/UPDATE assets/)).toHaveLength(0);
  });

  it('POST /assets/:id/swap rejects another org\'s device_id before closing the open assignment', async () => {
    wire(assetRows);
    const res = await request(app).post('/api/v1/assets/3/swap').send({ client_id: 4, device_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/asset_assignments/)).toHaveLength(0);
  });

  it('POST /assets/:id/assign accepts an own client and binds the asset write to the org', async () => {
    wire(assetRows);
    const res = await request(app).post('/api/v1/assets/3/assign').send({ client_id: 4 });
    expect(res.status).toBe(201);
    const [sql, params] = writes(/UPDATE assets SET lifecycle_status/)[0];
    expect(sql).toMatch(/WHERE id = \? AND organization_id <=> \?/);
    expect(params).toEqual(['assigned', 3, 1]);
  });

  it('POST /assets rejects another org\'s warehouse/inventory item', async () => {
    wire();
    const res = await request(app).post('/api/v1/assets').send({ name: 'ONU', warehouse_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?assets`?/)).toHaveLength(0);
  });

  it('Asset.getAssignments binds the client/device display joins to the assignment org', async () => {
    wire();
    await Asset.getAssignments(3, 1);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/JOIN clients c ON c\.id = aa\.client_id AND c\.organization_id <=> aa\.organization_id/);
    expect(sql).toMatch(/JOIN devices d ON d\.id = aa\.device_id AND d\.organization_id <=> aa\.organization_id/);
  });
});

// ---------------------------------------------------------------------------
describe('RMA requests (TNB-12)', () => {
  it('POST /rma-requests rejects another org\'s asset_id', async () => {
    wire();
    const res = await request(app).post('/api/v1/rma-requests').send({ rma_number: 'R1', asset_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?rma_requests`?/)).toHaveLength(0);
  });

  it('PUT /rma-requests/:id rejects re-pointing at another org\'s asset', async () => {
    wire((sql) => (/FROM `?rma_requests`? WHERE id = \?/.test(sql)
      ? [[{ id: 8, organization_id: 1, status: 'open', asset_id: 3 }]] : null));
    const res = await request(app).put('/api/v1/rma-requests/8').send({ asset_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/^UPDATE `?rma_requests`?/)).toHaveLength(0);
  });

  it('ship binds the asset lifecycle write to the caller org', async () => {
    wire((sql) => (/FROM `?rma_requests`? WHERE id = \?/.test(sql)
      ? [[{ id: 8, organization_id: 1, status: 'open', asset_id: FOREIGN }]] : null));
    const res = await request(app).post('/api/v1/rma-requests/8/ship').send({});
    expect(res.status).toBe(200);
    const [sql, params] = writes(/UPDATE assets SET lifecycle_status = 'rma'/)[0];
    expect(sql).toMatch(/organization_id <=> \?/);
    expect(params).toEqual([FOREIGN, 1]);
  });

  it('close rejects another org\'s replacement_asset_id', async () => {
    wire((sql) => (/FROM `?rma_requests`? WHERE id = \?/.test(sql)
      ? [[{ id: 8, organization_id: 1, status: 'received', asset_id: 3 }]] : null));
    const res = await request(app).post('/api/v1/rma-requests/8/close')
      .send({ status: 'closed', replacement_asset_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/^UPDATE/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('purchase orders (TNB-12)', () => {
  const po = { id: 6, organization_id: 1, status: 'sent', po_number: 'PO-6', warehouse_id: 2 };
  const poRows = (sql) => (/FROM `?purchase_orders`? WHERE id = \?/.test(sql) ? [[po]] : null);

  it('POST /purchase-orders rejects another org\'s warehouse_id', async () => {
    wire();
    const res = await request(app).post('/api/v1/purchase-orders').send({ po_number: 'X', warehouse_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?purchase_orders`?/)).toHaveLength(0);
  });

  it('POST /purchase-orders/:id/items rejects another org\'s inventory_item_id', async () => {
    wire(poRows);
    const res = await request(app).post('/api/v1/purchase-orders/6/items')
      .send({ description: 'ONU', quantity_ordered: 2, inventory_item_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO purchase_order_items/)).toHaveLength(0);
  });

  it('receive re-checks line items in the transaction and never touches stock for a foreign item', async () => {
    wire(poRows);
    const conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      query: jest.fn(async (sql, params = []) => {
        const own = ownershipAnswer(sql, params);
        if (own) return own;
        if (/FROM purchase_order_items WHERE po_id/.test(sql)) {
          return [[{ id: 11, po_id: 6, inventory_item_id: FOREIGN, quantity_ordered: 5, quantity_received: 0, unit_cost: 1 }]];
        }
        return [[]];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
    const res = await request(app).post('/api/v1/purchase-orders/6/receive').send({});
    expect(res.status).toBe(422);
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.query.mock.calls.some(([s]) => /inventory_stock/.test(s))).toBe(false);
  });

  it('PurchaseOrder.getItems scopes through the parent PO and binds the item join', async () => {
    wire();
    await PurchaseOrder.getItems(6, 1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/JOIN purchase_orders po ON po\.id = poi\.po_id AND po\.organization_id <=> \?/);
    expect(sql).toMatch(/i\.organization_id <=> po\.organization_id/);
    expect(params).toEqual([1, 6]);
  });
});

// ---------------------------------------------------------------------------
describe('CPE subscriber link and list (TNA-09)', () => {
  const cpe = (sql) => (/FROM `?cpe_devices`? WHERE id = \?/.test(sql)
    ? [[{ id: 4, organization_id: 1, lifecycle_state: 'in_stock' }]] : null);

  it('POST /cpe-management/devices/:id/subscriber-link rejects another org\'s client', async () => {
    wire(cpe);
    const res = await request(app).post('/api/v1/cpe-management/devices/4/subscriber-link')
      .send({ subscriber_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/UPDATE cpe_devices SET subscriber_id/)).toHaveLength(0);
  });

  it('POST /cpe-management/devices rejects another org\'s contract_id', async () => {
    wire();
    const res = await request(app).post('/api/v1/cpe-management/devices')
      .send({ serial_number: 'S1', oui: 'ABCDEF', contract_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?cpe_devices`?/)).toHaveLength(0);
  });

  it('GET /cpe-management/devices binds the subscriber name join to the unit org', async () => {
    wire();
    await request(app).get('/api/v1/cpe-management/devices');
    const [sql] = db.query.mock.calls.find(([s]) => /FROM cpe_devices d/.test(s) && !/COUNT/.test(s));
    expect(sql).toMatch(/JOIN clients c ON c\.id = d\.subscriber_id AND c\.organization_id <=> d\.organization_id/);
  });
});

// ---------------------------------------------------------------------------
describe('follow-up reminders (TNA-09)', () => {
  it('POST rejects another org\'s client_id', async () => {
    wire();
    const res = await request(app).post('/api/v1/follow-up-reminders')
      .send({ client_id: FOREIGN, title: 'Call', due_at: '2026-11-01 10:00:00', assigned_to: 1 });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?follow_up_reminders`?/)).toHaveLength(0);
  });

  it('POST rejects an assignee who is not a user of this org', async () => {
    wire((sql) => (/FROM users u/.test(sql) ? [[{ total: 0 }]] : null));
    const res = await request(app).post('/api/v1/follow-up-reminders')
      .send({ client_id: 4, title: 'Call', due_at: '2026-11-01 10:00:00', assigned_to: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO `?follow_up_reminders`?/)).toHaveLength(0);
  });

  it('GET / and /due bind the client name join to the reminder org', async () => {
    wire();
    await request(app).get('/api/v1/follow-up-reminders');
    await request(app).get('/api/v1/follow-up-reminders/due');
    const joins = db.query.mock.calls.filter(([s]) => /JOIN clients cl/.test(s));
    expect(joins.length).toBeGreaterThanOrEqual(3);
    for (const [sql] of joins) {
      expect(sql).toMatch(/JOIN clients cl ON cl\.id = r\.client_id AND cl\.organization_id <=> r\.organization_id/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('fiber plant (TNA-09)', () => {
  it('POST /fiber-routes rejects another org\'s device', async () => {
    wire();
    const res = await request(app).post('/api/v1/fiber-plant/fiber-routes')
      .send({ name: 'Drop', route_type: 'drop', from_device_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO fiber_routes/)).toHaveLength(0);
  });

  it('POST /odf/frames rejects another org\'s site', async () => {
    wire();
    const res = await request(app).post('/api/v1/fiber-plant/odf/frames')
      .send({ name: 'F1', site_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/INSERT INTO odf_frames/)).toHaveLength(0);
  });

  it('PATCH /sfp/:id rejects installing into another org\'s device', async () => {
    wire((sql) => (/SELECT id FROM sfp_inventory/.test(sql) ? [[{ id: 15 }]] : null));
    const res = await request(app).patch('/api/v1/fiber-plant/sfp/15')
      .send({ lifecycle_status: 'installed', installed_device_id: FOREIGN });
    expect(res.status).toBe(422);
    expect(writes(/^UPDATE sfp_inventory/)).toHaveLength(0);
  });

  it('fiber route list binds device/splitter display joins', async () => {
    wire();
    await request(app).get('/api/v1/fiber-plant/fiber-routes');
    const [sql] = db.query.mock.calls.find(([s]) => /FROM fiber_routes fr/.test(s) && /LEFT JOIN devices fd/.test(s));
    expect(sql).toMatch(/fd\.organization_id <=> fr\.organization_id OR fd\.organization_id IS NULL/);
    expect(sql).toMatch(/sp\.organization_id <=> fr\.organization_id OR sp\.organization_id IS NULL/);
  });

  it('SFP diagnostics read snmp_metrics only through a device visible to the org', async () => {
    wire((sql) => (/SELECT id, installed_device_id FROM sfp_inventory/.test(sql)
      ? [[{ id: 15, installed_device_id: FOREIGN }]] : null));
    await request(app).get('/api/v1/fiber-plant/sfp/15/diagnostics');
    const [sql, params] = db.query.mock.calls.find(([s]) => /FROM snmp_metrics/.test(s));
    expect(sql).toMatch(/JOIN devices d ON d\.id = m\.device_id/);
    expect(params).toEqual([1, FOREIGN]);
  });
});
