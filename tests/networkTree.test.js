// The network as a tree: main NAS routers at the top, what they feed under
// them, and equipment that has not been placed yet listed beside the trees.
jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const tree = require('../src/services/networkTreeService');

function tx(handler) {
  const calls = [];
  const conn = {
    calls,
    beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
    query: jest.fn(async (sql, params) => { const flat = sql.replace(/\s+/g, ' ').trim(); calls.push([flat, params]); return handler(flat, params); }),
  };
  db.getConnection.mockResolvedValue(conn);
  return conn;
}

const dev = (id, name, type, parent = null, extra = {}) => ({ id, name, type, status: 'online', site_id: 1, parent_device_id: parent, ip_address: null, latitude: null, longitude: null, site_name: 'Tower', ...extra });

beforeEach(() => { db.query.mockReset(); db.getConnection.mockReset(); });

describe('getTree', () => {
  function load(devices, nas) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [devices];
      if (/FROM nas n/.test(sql)) return [nas];
      return [[{ id: 1, name: 'Tower', latitude: '19.40000000', longitude: '-99.10000000' }]];
    });
  }

  test('one tree per main NAS, branches under it, the rest unplaced', async () => {
    load([
      dev(10, 'Core A', 'router'), dev(11, 'PtP north', 'ptp', 10), dev(12, 'OLT 1', 'olt', 11),
      dev(13, 'Battery', 'battery_monitor', 10), dev(20, 'Core B', 'router'), dev(21, 'Switch B', 'switch', 20),
      dev(30, 'Spare AP', 'ptmp_ap'),
    ], [
      { id: 1, name: 'Core A', type: 'mikrotik', device_id: 10, is_main: 1 },
      { id: 2, name: 'Core B', type: 'cisco', device_id: 20, is_main: 1 },
      { id: 3, name: 'New NAS', type: null, device_id: null, is_main: 0, site_id: 4, site_name: 'POP' },
    ]);
    const out = await tree.getTree(5);
    expect(out.trees.map((t) => t.name)).toEqual(['Core A', 'Core B']);
    expect(out.trees[0]).toMatchObject({ kind: 'nas', nas_id: 1, is_main: true, make: 'mikrotik' });
    expect(out.trees[0].children.map((c) => c.name)).toEqual(['Battery', 'PtP north']);
    expect(out.trees[0].children[1].children[0]).toMatchObject({ id: 12, type: 'olt', parent_id: 11 });
    expect(out.trees[1].children.map((c) => c.id)).toEqual([21]);
    expect(out.unplaced.map((u) => u.id)).toEqual(['nas-3', 30]);
    expect(out.unplaced[0]).toMatchObject({ kind: 'nas', nas_id: 3, site_name: 'POP', is_main: false });
  });

  test('subscriber equipment is left out and both queries are scoped to the organization', async () => {
    load([], []);
    await tree.getTree(5);
    const [deviceSql, deviceParams] = db.query.mock.calls[0];
    expect(deviceSql).toMatch(/d\.organization_id = \? AND d\.deleted_at IS NULL/);
    expect(deviceParams).toEqual([5, 'outdoor_cpe', 'indoor_cpe', 'onu']);
    expect(db.query.mock.calls[1][0]).toMatch(/n\.organization_id = \? AND n\.deleted_at IS NULL/);
    expect(db.query.mock.calls[1][1]).toEqual([5]);
    expect(db.query.mock.calls[2]).toEqual(['SELECT id, name, latitude, longitude FROM sites WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name', [5]]);
    expect((await tree.getTree(5)).sites).toEqual([{ id: 1, name: 'Tower', latitude: 19.4, longitude: -99.1 }]);
  });

  test('a loop in stored data does not hang: its members are listed as unplaced', async () => {
    load([dev(1, 'A', 'switch', 2), dev(2, 'B', 'switch', 1)], []);
    const out = await tree.getTree(5);
    expect(out.trees).toEqual([]);
    expect(out.unplaced.map((u) => u.id).sort()).toEqual([1, 2]);
    expect(out.unplaced.every((u) => u.children.length === 0)).toBe(true);
  });

  test('a parent that no longer exists leaves its child unplaced, not lost', async () => {
    load([dev(7, 'Orphan', 'switch', 999)], []);
    const out = await tree.getTree(5);
    expect(out.unplaced.map((u) => u.id)).toEqual([7]);
  });
});

describe('setParent', () => {
  // parents: child id -> parent id
  function world(parents, { main = [] } = {}) {
    return tx((sql, params) => {
      if (/COALESCE\(n\.is_main, 0\)/.test(sql)) return [[{ id: params[0], is_main: main.includes(params[0]) ? 1 : 0 }]];
      if (/^SELECT parent_device_id FROM devices/.test(sql)) return [[{ parent_device_id: parents[params[0]] ?? null }]];
      if (/^SELECT id FROM devices/.test(sql)) return [[{ id: params[0] }]];
      return [{ affectedRows: 1 }];
    });
  }

  test('places equipment under a parent of the same organization', async () => {
    const conn = world({ 11: 10 });
    await expect(tree.setParent(5, 12, 11)).resolves.toEqual({ id: 12, parent_id: 11 });
    expect(conn.calls.at(-1)).toEqual(['UPDATE devices SET parent_device_id = ? WHERE id = ? AND organization_id = ?', [11, 12, 5]]);
    expect(conn.calls.filter(([sql]) => /^SELECT id FROM devices/.test(sql)).every(([, p]) => p[1] === 5)).toBe(true);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('parent null takes it out of the tree', async () => {
    const conn = world({});
    await expect(tree.setParent(5, 12, null)).resolves.toEqual({ id: 12, parent_id: null });
    expect(conn.calls.at(-1)[1]).toEqual([null, 12, 5]);
  });

  test('refused: itself, a loop, and a parent for a main NAS', async () => {
    let conn = world({});
    await expect(tree.setParent(5, 12, 12)).rejects.toThrow(/under itself/);
    expect(conn.rollback).toHaveBeenCalled();
    // 10 > 11 > 12: putting 10 under 12 would make a loop.
    conn = world({ 12: 11, 11: 10 });
    await expect(tree.setParent(5, 10, 12)).rejects.toThrow(/loop/);
    expect(conn.calls.some(([sql]) => /^UPDATE devices/.test(sql))).toBe(false);
    world({}, { main: [10] });
    await expect(tree.setParent(5, 10, 11)).rejects.toThrow(/main NAS/);
  });

  test('equipment of another organization is not found', async () => {
    tx(() => [[]]);
    await expect(tree.setParent(5, 12, 11)).rejects.toThrow(/does not exist/);
  });
});

describe('setMain', () => {
  const nasWorld = () => tx((sql) => {
    if (/FROM nas n/.test(sql)) return [[{ id: 3, name: 'Core', device_id: 40 }]];
    if (/^SELECT id FROM devices/.test(sql)) return [[{ id: 40 }]];
    return [{ affectedRows: 1 }];
  });

  test('a main NAS becomes a root: it is marked and loses its parent', async () => {
    const conn = nasWorld();
    await expect(tree.setMain(5, 3, true)).resolves.toEqual({ nas_id: 3, device_id: 40, is_main: true });
    expect(conn.calls).toContainEqual(['UPDATE nas SET is_main = ? WHERE id = ? AND organization_id = ?', [1, 3, 5]]);
    expect(conn.calls).toContainEqual(['UPDATE devices SET parent_device_id = NULL WHERE id = ? AND organization_id = ?', [40, 5]]);
  });

  test('unmarking keeps its place and its branches', async () => {
    const conn = nasWorld();
    await expect(tree.setMain(5, 3, false)).resolves.toMatchObject({ is_main: false });
    expect(conn.calls).toContainEqual(['UPDATE nas SET is_main = ? WHERE id = ? AND organization_id = ?', [0, 3, 5]]);
    expect(conn.calls.some(([sql]) => /parent_device_id = NULL/.test(sql))).toBe(false);
  });

  test('a NAS id that is not a whole number is refused before any query', async () => {
    for (const bad of ['abc', 0, -1, '3 OR 1=1', 1.5]) await expect(tree.setMain(5, bad, true)).rejects.toThrow(/does not exist/);
    expect(db.getConnection).not.toHaveBeenCalled();
  });
});

describe('setPosition', () => {
  test('saves a point for a device of the organization', async () => {
    const conn = tx((sql, params) => (/^SELECT id FROM devices/.test(sql) ? [[{ id: params[0] }]] : [{ affectedRows: 1 }]));
    await expect(tree.setPosition(5, 12, 19.43261234567, -99.1332)).resolves.toEqual({ id: 12, latitude: 19.4326123, longitude: -99.1332 });
    expect(conn.calls.at(-1)).toEqual(['UPDATE devices SET latitude = ?, longitude = ? WHERE id = ? AND organization_id = ?', [19.4326123, -99.1332, 12, 5]]);
  });

  test('refuses what is not a point on the map', async () => {
    for (const [lat, lng] of [[91, 0], [0, 181], ['x', 0], [null, 0], [0, undefined], [true, 1], ['', 3]]) {
      await expect(tree.setPosition(5, 12, lat, lng)).rejects.toThrow(/not a point/);
    }
    expect(db.getConnection).not.toHaveBeenCalled();
  });
});
