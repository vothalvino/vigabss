// =============================================================================
// FE2-03 — the Traffic Engineering forms send fields and values the API accepts
// =============================================================================
// The page sent algorithm/max_bandwidth_mbps/committed_bandwidth_mbps,
// match_port_range, vlan_id/mpls_label/priority_bits/queue_class and values
// such as 'pfifo', 'passthrough', 'vlan' and 'speedtest'. The validators
// accepted enum values the ENUM columns reject (a 500) and fields no table
// has, and WRITABLE_COLS listed vendor_platform, which is not a column.
// Each validator, whitelist and page list is checked against schema.sql.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn(), pool: { end: jest.fn() } }));

const fs = require('fs');
const path = require('path');
const { WRITABLE_COLS } = require('../src/routes/trafficEngineering');
const qos = require('../src/middleware/schemas/interfaceQosPolicies');
const dscp = require('../src/middleware/schemas/dscpMarkingPolicies');
const mpls = require('../src/middleware/schemas/mplsVlanPrioritization');
const bwt = require('../src/middleware/schemas/bandwidthTestServers');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
function table(name) {
  const start = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  const body = schemaSql.slice(start, schemaSql.indexOf(') ENGINE=', start));
  const cols = {};
  for (const [, col, type] of body.matchAll(/^\s+([a-z_0-9]+)\s+(ENUM\([^)]*\)|[A-Z]+)/gm)) {
    cols[col] = type.startsWith('ENUM') ? [...type.matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;
  }
  return cols;
}

const VALIDATORS = [
  ['interface_qos_policies', qos.createInterfaceQosPolicy, qos.updateInterfaceQosPolicy],
  ['dscp_marking_policies', dscp.createDscpMarkingPolicy, dscp.updateDscpMarkingPolicy],
  ['mpls_vlan_prioritization_rules', mpls.createMplsVlanRule, mpls.updateMplsVlanRule],
  ['bandwidth_test_servers', bwt.createBandwidthTestServer, bwt.updateBandwidthTestServer],
];

describe.each(VALIDATORS)('%s', (tableName, create, update) => {
  const cols = table(tableName);

  test('every validator field is a column and every enum value is in its ENUM', () => {
    for (const schema of [create, update]) {
      expect(Object.keys(schema).filter((k) => !(k in cols))).toEqual([]);
      for (const [k, rule] of Object.entries(schema)) {
        if (rule.enum) expect(rule.enum.filter((v) => !cols[k].includes(v))).toEqual([]);
      }
    }
  });

  test('every whitelisted key is a column', () => {
    const allowed = WRITABLE_COLS[tableName];
    if (allowed) expect([...allowed].filter((k) => !(k in cols))).toEqual([]);
  });
});

const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'pages', 'QosBandwidthPage.tsx'), 'utf8');
const list = (name) => {
  const start = page.indexOf(`const ${name} =`);
  expect(start).toBeGreaterThan(-1);
  return [...page.slice(start, page.indexOf('];', start)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
const bodyFields = (iface) => {
  const start = page.indexOf(`interface ${iface} {`);
  return [...page.slice(start, page.indexOf('\n}', start)).matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]);
};

test.each([
  ['QOS_POLICY_TYPES', 'interface_qos_policies', 'policy_type'],
  ['QOS_DIRECTIONS', 'interface_qos_policies', 'direction'],
  ['DSCP_TRAFFIC_CLASSES', 'dscp_marking_policies', 'traffic_class'],
  ['PROTOCOLS', 'dscp_marking_policies', 'match_protocol'],
  ['DSCP_ACTIONS', 'dscp_marking_policies', 'action'],
  ['MPLS_VLAN_RULE_TYPES', 'mpls_vlan_prioritization_rules', 'rule_type'],
  ['BWT_PROTOCOLS', 'bandwidth_test_servers', 'protocol'],
])('the page list %s is the %s.%s ENUM', (name, tableName, col) => {
  expect(list(name).sort()).toEqual([...table(tableName)[col]].sort());
});

test.each([
  ['InterfaceQosPolicyBody', qos.createInterfaceQosPolicy],
  ['DscpMarkingPolicyBody', dscp.createDscpMarkingPolicy],
  ['MplsVlanRuleBody', mpls.createMplsVlanRule],
  ['BandwidthTestServerBody', bwt.createBandwidthTestServer],
])('every %s field is one the validator accepts', (iface, schema) => {
  const fields = bodyFields(iface);
  expect(fields.length).toBeGreaterThan(2);
  expect(fields.filter((f) => !(f in schema))).toEqual([]);
});
