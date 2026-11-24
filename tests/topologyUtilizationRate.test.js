// =============================================================================
// NPR-04 — link utilization comes from counter deltas, not counter totals
// =============================================================================
// getNetworkGraph summed the raw cumulative ifHC*Octets of the last 5 minutes
// and divided by 300 s, so a 10 Gbps link averaging ~20 Mbps showed 100%, and
// every edge on the Topology Map and Network Fabric tabs sat in the red. The
// bandwidth, top-consumer and congested-link reports averaged counter
// positions the same way.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), queryReplica: jest.fn() }));

const db = require('../src/config/database');
const topology = require('../src/services/topologyMapService');
const reports = require('../src/services/reportService');

const LINK = { id: 1, device_a_id: 7, device_b_id: 8, medium: 'fiber', role: 'backhaul', status: 'active', bandwidth_mbps: 10000 };
// Months of uptime: counters in the hundreds of terabytes.
const BASE_IN = 900e12;
const BASE_OUT = 400e12;

function wire(buckets, link = LINK) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM devices d/.test(sql)) return [[{ id: 7 }, { id: 8 }]];
    if (/FROM network_links nl/.test(sql)) return [[link]];
    if (/FROM snmp_metrics/.test(sql)) return [buckets];
    return [[]];
  });
}

beforeEach(() => jest.clearAllMocks());

test('a quiet link on long-running counters reads as quiet', async () => {
  // 60 s apart: 150 MB in (20 Mbps), 75 MB out.
  wire([
    { device_id: 7, minute_bucket: 2, ts: 1060, in_octets: BASE_IN + 150e6, out_octets: BASE_OUT + 75e6, iface_signature: '1,2' },
    { device_id: 7, minute_bucket: 1, ts: 1000, in_octets: BASE_IN, out_octets: BASE_OUT, iface_signature: '1,2' },
  ]);
  const { edges } = await topology.getNetworkGraph(1);
  expect(edges[0].utilization).toBe(0); // 20 Mbps of 10 Gbps rounds to 0%
});

test('a busy link shows its real share of capacity', async () => {
  // 60 s apart: 60 GB in = 8 Gbps on a 10 Gbps link.
  wire([
    { device_id: 7, minute_bucket: 2, ts: 1060, in_octets: BASE_IN + 60e9, out_octets: BASE_OUT + 1e9, iface_signature: '1,2' },
    { device_id: 7, minute_bucket: 1, ts: 1000, in_octets: BASE_IN, out_octets: BASE_OUT, iface_signature: '1,2' },
  ]);
  const { edges } = await topology.getNetworkGraph(1);
  expect(edges[0].utilization).toBe(80);
});

test.each([
  ['the interface set changed', [{ iface_signature: '1,2,3' }, { iface_signature: '1,2' }]],
  ['a counter went backwards', [{ in_octets: BASE_IN - 1 }, {}]],
  ['only one sample', [{}]],
])('no rate when %s', async (_name, [newerOver, olderOver]) => {
  const newer = { device_id: 7, minute_bucket: 2, ts: 1060, in_octets: BASE_IN + 1e6, out_octets: BASE_OUT + 1e6, iface_signature: '1,2', ...newerOver };
  const older = olderOver && { device_id: 7, minute_bucket: 1, ts: 1000, in_octets: BASE_IN, out_octets: BASE_OUT, iface_signature: '1,2', ...olderOver };
  wire(older ? [newer, older] : [newer]);
  const { edges } = await topology.getNetworkGraph(1);
  expect(edges[0].utilization).toBeNull();
});

describe('the network reports use per-day counter movement', () => {
  beforeEach(() => db.queryReplica.mockResolvedValue([[]]));

  test.each([
    ['bandwidthUtilization', () => reports.bandwidthUtilization(1)],
    ['topConsumers', () => reports.topConsumers(1)],
    ['congestedLinks', () => reports.congestedLinks(1)],
  ])('%s', async (_name, run) => {
    await run();
    const [sql] = db.queryReplica.mock.calls[0];
    expect(sql).toMatch(/GREATEST\(COALESCE\(m\.max_if_in_octets - m\.min_if_in_octets, 0\), 0\)/);
    expect(sql).toMatch(/GREATEST\(COALESCE\(m\.max_if_out_octets - m\.min_if_out_octets, 0\), 0\)/);
    expect(sql).not.toMatch(/avg_if_(in|out)_octets/);
  });
});

// NAS routers live in their own table and were missing from the map. They are
// drawn at their site; one whose site has no location is reported instead.
describe('NAS routers on the map', () => {
  function withNas(nasRows) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [[{ id: 7, name: 'Tower AP', latitude: 19.4, longitude: -99.1 }]];
      if (/FROM nas n/.test(sql)) return [nasRows];
      return [[]];
    });
  }

  test('a NAS appears as a node at its site\'s coordinates, told apart from devices', async () => {
    withNas([{ id: 3, name: 'Core Router', type: 'mikrotik', status: 'active', ip_address: '10.0.0.1', site_id: 2, site_name: 'POP Centro', latitude: '19.43260000', longitude: '-99.13320000' }]);
    const graph = await topology.getNetworkGraph(1);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[1]).toEqual({
      id: 'nas-3', kind: 'nas', nas_id: 3, name: 'Core Router', type: 'nas', role: 'mikrotik', status: 'active',
      latitude: 19.4326, longitude: -99.1332, ip_address: '10.0.0.1', site_id: 2, site_name: 'POP Centro',
    });
    // Its id can never collide with a device's numeric id.
    expect(graph.nodes.map((n) => n.id)).toEqual([7, 'nas-3']);
    expect(graph.nas_without_location).toEqual([]);
  });

  test('a NAS with no site, or a site with no coordinates, is listed instead of guessed at', async () => {
    withNas([
      { id: 4, name: 'Edge A', type: 'mikrotik', status: 'active', site_id: null, site_name: null, latitude: null, longitude: null },
      { id: 5, name: 'Edge B', type: 'cisco', status: 'active', site_id: 9, site_name: 'Torre Norte', latitude: null, longitude: null },
    ]);
    const graph = await topology.getNetworkGraph(1);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nas_without_location).toEqual([
      { id: 4, name: 'Edge A', site_name: null }, { id: 5, name: 'Edge B', site_name: 'Torre Norte' },
    ]);
  });

  test('only this organization\'s live NAS routers are read', async () => {
    withNas([]);
    await topology.getNetworkGraph(6);
    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM nas n/.test(q));
    expect(sql.replace(/\s+/g, ' ')).toMatch(/WHERE n\.deleted_at IS NULL AND n\.organization_id = \?/);
    expect(params).toEqual([6]);
  });
});

// A link can be drawn between any two points of the map. A NAS router becomes
// a device the first time it is linked, so links, placement and the rest of
// the map treat it like any other equipment.
describe('drawing a link on the map', () => {
  function tx(handler) {
    const calls = [];
    const conn = {
      calls,
      beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
      query: jest.fn(async (sql, params) => { calls.push([sql.replace(/\s+/g, ' ').trim(), params]); return handler(sql, params); }),
    };
    db.getConnection = jest.fn(async () => conn);
    return conn;
  }

  test('two devices: both must be this organization\'s, and the link is stored once', async () => {
    const conn = tx((sql) => {
      if (/FROM devices/.test(sql)) return [[{ id: 7 }]];
      if (/FROM network_links/.test(sql)) return [[]];
      return [{ insertId: 55 }];
    });
    conn.query.mockImplementation(async (sql, params) => {
      conn.calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/FROM devices/.test(sql)) return [[{ id: params[0] }]];
      if (/FROM network_links/.test(sql)) return [[]];
      return [{ insertId: 55 }];
    });
    const link = await topology.createLink(3, { a: 7, b: 8, link_type: 'wireless', capacity_mbps: 500 });
    expect(link).toEqual({ id: 55, source: 7, target: 8, link_type: 'wireless', capacity_mbps: 500 });
    expect(conn.calls[0]).toEqual(['SELECT id FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [7, 3]]);
    const insert = conn.calls.find(([sql]) => /INSERT INTO network_links/.test(sql));
    expect(insert[1]).toEqual([3, 7, 8, 'wireless', 'wireless', 500]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('a NAS becomes a device at its site the first time it is linked', async () => {
    const conn = tx(() => [[]]);
    conn.query.mockImplementation(async (sql, params) => {
      conn.calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/FROM nas n/.test(sql)) return [[{ id: 4, name: 'Core Router', type: 'mikrotik', ip_address: '10.0.0.1', site_id: 2, device_id: null, latitude: '19.43260000', longitude: '-99.13320000' }]];
      if (/INSERT INTO devices/.test(sql)) return [{ insertId: 90 }];
      if (/FROM devices/.test(sql)) return [[{ id: params[0] }]];
      if (/FROM network_links/.test(sql)) return [[]];
      return [{ insertId: 56, affectedRows: 1 }];
    });
    const link = await topology.createLink(3, { a: 'nas-4', b: 7 });
    expect(link).toMatchObject({ source: 90, target: 7, link_type: 'fiber', capacity_mbps: null });
    const nas = conn.calls.find(([sql]) => /FROM nas n/.test(sql));
    expect(nas[0]).toMatch(/WHERE n\.id = \? AND n\.organization_id = \? AND n\.deleted_at IS NULL FOR UPDATE$/);
    expect(nas[1]).toEqual([4, 3]);
    const device = conn.calls.find(([sql]) => /INSERT INTO devices/.test(sql));
    expect(device[1]).toEqual([3, 2, 'Core Router', 'mikrotik', '10.0.0.1', '19.43260000', '-99.13320000']);
    expect(conn.calls.find(([sql]) => /UPDATE nas SET device_id/.test(sql))[1]).toEqual([90, 4, 3]);
  });

  test('a NAS that already has its device reuses it', async () => {
    const conn = tx(() => [[]]);
    conn.query.mockImplementation(async (sql, params) => {
      conn.calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/FROM nas n/.test(sql)) return [[{ id: 4, name: 'Core Router', device_id: 90 }]];
      if (/FROM devices/.test(sql)) return [[{ id: params[0] }]];
      if (/FROM network_links/.test(sql)) return [[]];
      return [{ insertId: 57 }];
    });
    await expect(topology.createLink(3, { a: 'nas-4', b: 7 })).resolves.toMatchObject({ source: 90, target: 7 });
    expect(conn.calls.some(([sql]) => /INSERT INTO devices/.test(sql))).toBe(false);
  });

  test('refused: an unknown point, the same point twice, a pair already linked, a bad type', async () => {
    let conn = tx(() => [[]]);
    await expect(topology.createLink(3, { a: 7, b: 8 })).rejects.toThrow(/does not exist/);
    expect(conn.rollback).toHaveBeenCalled();

    conn = tx(() => [[]]);
    conn.query.mockImplementation(async (sql, params) => (/FROM devices/.test(sql) ? [[{ id: params[0] }]] : [[]]));
    await expect(topology.createLink(3, { a: 7, b: 7 })).rejects.toThrow(/two different points/);

    conn = tx(() => [[]]);
    conn.query.mockImplementation(async (sql, params) => {
      if (/FROM devices/.test(sql)) return [[{ id: params[0] }]];
      if (/FROM network_links/.test(sql)) return [[{ id: 1 }]];
      return [{ insertId: 1 }];
    });
    await expect(topology.createLink(3, { a: 7, b: 8 })).rejects.toThrow(/already linked/);

    await expect(topology.createLink(3, { a: 7, b: 8, link_type: 'laser' })).rejects.toThrow(/link_type/);
    for (const bad of ['nas-0', 'nas-4; DROP', '7 OR 1=1', -1, null]) {
      tx(() => [[]]);
      await expect(topology.createLink(3, { a: bad, b: 8 })).rejects.toThrow();
    }
  });

  test('a linked NAS is one marker on the map, its device, labelled as the NAS', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM devices d/.test(sql)) return [[{ id: 90, name: 'Core Router', type: 'router', role: 'core', latitude: 19.4, longitude: -99.1 }]];
      if (/FROM nas n/.test(sql)) return [[{ id: 4, name: 'Core Router', type: 'mikrotik', status: 'active', device_id: 90, site_id: 2, latitude: '19.4', longitude: '-99.1' }]];
      return [[]];
    });
    const graph = await topology.getNetworkGraph(3);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ id: 90, kind: 'nas', nas_id: 4, role: 'mikrotik' });
  });

  test('removing a link is scoped to the organization', async () => {
    db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(topology.removeLink(3, 55)).resolves.toEqual({ id: 55, removed: true });
    expect(db.query.mock.calls.at(-1)).toEqual(['UPDATE network_links SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [55, 3]]);
    db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(topology.removeLink(3, 55)).rejects.toMatchObject({ statusCode: 404 });
  });
});
