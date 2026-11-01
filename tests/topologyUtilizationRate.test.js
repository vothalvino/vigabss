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
