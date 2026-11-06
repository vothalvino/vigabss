'use strict';
// =============================================================================
// IPv6 in the case-gated legal IP attribution lookup (migration 524)
// =============================================================================
// The lookup and government ip_traceability requests took IPv4 only; IPv6
// had to be answered by hand from the session search and NAS logs. IPv6 has
// no CGNAT: a subscriber holds an address when it is their WAN address or
// falls inside a prefix routed to them. The lookup applies the IPv4 rules
// (assignment evidence by the instant, closure after it or a live session,
// complete evidence, no competing session) with prefix containment, and pins
// its evidence as direct_ipv6_assignment. The append-only evidence now
// records the delegated prefix and the WAN address it used to drop.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn(callback => callback()),
}));
jest.mock('../src/models/User', () => ({ getPermissions: jest.fn() }));
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn().mockResolvedValue({ id: 50 }),
}));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const { lookupAttribution, normalizeLookup } = require('../src/services/cgnatAttributionService');
const { governmentRequestRowHash } = require('../src/utils/govDataRequestIntegrity');
const { canonicalIpv6Prefix, containingIpv6Prefixes, isGloballyRoutableIpv6 } = require('../src/utils/ipAddress');

const ORG = 10;
const OBSERVED_AT = '2026-08-01T00:30:00.000Z';
const ADDRESS = '2806:2f0:1:2::5';
const DELEGATED = '2806:2f0:1::/48';

function requestCase(over = {}) {
  const row = {
    id: 81, organization_id: ORG, request_type: 'ip_traceability', status: 'processing',
    authority_name: 'Authority', authority_ref: 'AUTH-6', legal_basis: 'Exact source attribution request',
    legal_reviewed_at: new Date('2026-07-31T00:00:00.000Z'), legal_reviewed_by: 1,
    client_id: null, contract_id: null, ip_address: ADDRESS, public_port: null, protocol: null,
    observed_at: new Date(OBSERVED_AT), created_at: new Date('2026-07-31T00:00:00.000Z'),
    ...over,
  };
  row.row_hash = governmentRequestRowHash(row);
  return row;
}

function sessionRow(over = {}) {
  return {
    connection_log_id: 31, client_id: 41, contract_id: 51, username: 'subscriber-6',
    radius_session_id: 'radius-6', session_instance_id: '66666666-6666-4666-8666-666666666666',
    framed_ipv6_prefix: null, ipv6_delegated_prefix: DELEGATED, ipv6_address: '2806:2f0:ff::2',
    assigned_at: new Date('2026-08-01T00:05:00.000Z'),
    assignment_evidence_id: 61,
    assignment_evidence_event_at: new Date('2026-08-01T00:05:00.000Z'),
    assignment_evidence_received_at: new Date('2026-08-01T00:07:00.000Z'),
    assignment_evidence_integrity_hash: 'a'.repeat(64),
    closure_evidence_id: null, released_at: null,
    closure_evidence_received_at: null, closure_evidence_integrity_hash: null,
    last_accounting_at: new Date('2026-08-01T00:45:00.000Z'),
    last_accounting_received_at: new Date('2026-08-01T00:40:00.000Z'),
    client_name: 'Subscriber Six',
    ...over,
  };
}

function databaseWith({ sessions = [sessionRow()], blockers = 0, request = requestCase() } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM gov_data_requests/.test(sql)) return [[request]];
    if (/SELECT COUNT\(\*\) AS blockers/.test(sql)) return [[{ blockers }]];
    if (/FROM connection_logs cl/.test(sql)) return [sessions];
    if (/INSERT INTO ip_attribution_case_evidence/.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
  });
}

const body = (over = {}) => ({ gov_data_request_id: 81, ip_address: ADDRESS, observed_at: OBSERVED_AT, ...over });

beforeEach(() => jest.clearAllMocks());

describe('an IPv6 lookup', () => {
  test('matches the session whose delegated prefix contains the address, and says so', async () => {
    databaseWith();
    const result = await lookupAttribution(ORG, body(), { pin: false });

    expect(result).toMatchObject({
      status: 'matched', attributionMethod: 'direct_ipv6_assignment',
      query: { ip_address: ADDRESS, ip_version: 6, public_ipv4: null, public_port: null },
      attribution: {
        client_id: 41, contract_id: 51, ip_address: ADDRESS, ip_version: 6, public_ipv4: null,
        ipv6_matched_by: 'ipv6_delegated_prefix', ipv6_delegated_prefix: DELEGATED,
      },
    });
  });

  test('searches sessions and evidence by every prefix containing the address and by the WAN address', async () => {
    databaseWith();
    await lookupAttribution(ORG, body(), { pin: false });

    const [sql, params] = db.query.mock.calls.find(([q]) => /FROM connection_logs cl\s+JOIN radius_accounting_events assignment_evidence/.test(q));
    // The session: framed prefix, delegated prefix or WAN address.
    expect(sql).toMatch(/cl\.framed_ipv6_prefix IN \(/);
    expect(sql).toMatch(/cl\.ipv6_delegated_prefix IN \(/);
    expect(sql).toMatch(/cl\.ipv6_address = \?/);
    // The evidence the match stands on carries the same, at the instant.
    expect(sql).toMatch(/assignment_pick\.delegated_ipv6_prefix IN \(/);
    expect(sql).toMatch(/assignment_pick\.framed_ipv6_address = \?/);
    expect(sql).toMatch(/closure_pick\.status_type = 'stop'\s+AND \(closure_pick\.framed_ipv6_prefix IN/);
    // The IPv4 rules hold.
    expect(sql).toMatch(/cl\.attribution_evidence_complete = 1/);
    expect(sql).toMatch(/assignment_pick\.event_at <= \?\s+AND assignment_pick\.observed_at <= \?/);
    expect(params).toEqual(expect.arrayContaining([DELEGATED, `${ADDRESS}/128`, ADDRESS, ORG]));
    expect(params.filter(p => p === DELEGATED)).toHaveLength(6);
  });

  test('another session holding the address or a containing prefix makes it ambiguous', async () => {
    databaseWith({ blockers: 1 });
    const result = await lookupAttribution(ORG, body(), { pin: false });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'overlapping_unverified_session', candidate_count: 2 });
    expect(result).not.toHaveProperty('attribution');
    const [sql] = db.query.mock.calls.find(([q]) => /AS blockers/.test(q));
    expect(sql).toMatch(/cl\.ipv6_delegated_prefix IN \(/);
    expect(sql).toMatch(/cl\.id <> \?/);
  });

  test('two sessions whose prefixes both contain the address are ambiguous, never a guess', async () => {
    databaseWith({ sessions: [sessionRow(), sessionRow({ connection_log_id: 32, ipv6_delegated_prefix: '2806:2f0:1:2::/64' })] });
    const result = await lookupAttribution(ORG, body(), { pin: false });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'multiple_attribution_candidates', candidate_count: 2 });
  });

  test('no session holding it at the instant is unavailable', async () => {
    databaseWith({ sessions: [] });
    const result = await lookupAttribution(ORG, body(), { pin: false });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'no_direct_assignment' });
  });

  test('pins its evidence as direct_ipv6_assignment with the address', async () => {
    databaseWith();
    const result = await lookupAttribution(ORG, body(), { actorId: 5 });
    expect(result.evidence_snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    const [sql, params] = db.query.mock.calls.find(([q]) => /INSERT INTO ip_attribution_case_evidence/.test(q));
    expect(sql).toMatch(/query_key, ip_address,\s+public_ipv4/);
    expect(params[2]).toBe('direct_ipv6_assignment');
    expect(params).toContain(ADDRESS);
    // public_ipv4 is null for IPv6.
    expect(params[params.indexOf(ADDRESS) + 1]).toBeNull();
  });

  test('must be the exact address the approved case names, in any text form', async () => {
    databaseWith({ request: requestCase({ ip_address: '2806:02F0:0001:0002:0000:0000:0000:0005' }) });
    await expect(lookupAttribution(ORG, body(), { pin: false })).resolves.toMatchObject({ status: 'matched' });

    databaseWith({ request: requestCase({ ip_address: '2806:2f0:1:2::6' }) });
    await expect(lookupAttribution(ORG, body(), { pin: false })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('takes no port or protocol: IPv6 has no CGNAT', () => {
    expect(() => normalizeLookup(body({ public_port: 443, protocol: 'tcp' }))).toThrow(/No port for IPv6/);
  });

  test('refuses an address that cannot name one subscriber', () => {
    for (const address of ['fe80::1', 'fd00::1', '2001:db8::1', '2002:c000:204::1', 'ff02::1']) {
      expect(() => normalizeLookup(body({ ip_address: address }))).toThrow(/Invalid ip_address/);
    }
  });

  test('an IPv4 lookup by ip_address is the IPv4 lookup', () => {
    expect(normalizeLookup(body({ ip_address: '8.8.8.8' }))).toMatchObject({ ip_version: 4, ip_address: '8.8.8.8', public_ipv4: '8.8.8.8' });
    expect(normalizeLookup({ gov_data_request_id: 81, public_ipv4: '8.8.8.8', observed_at: OBSERVED_AT }))
      .toMatchObject({ ip_version: 4, public_ipv4: '8.8.8.8' });
  });
});

describe('IPv6 addresses and prefixes', () => {
  test('a prefix is stored as its network, host bits zeroed', () => {
    expect(canonicalIpv6Prefix('2806:2F0:1:FFFF::5/48')).toBe('2806:2f0:1::/48');
    expect(containingIpv6Prefixes(ADDRESS)).toContain(canonicalIpv6Prefix('2806:2f0:1:9::/48'));
  });

  test('only global unicast that can name a subscriber is routable', () => {
    expect(isGloballyRoutableIpv6(ADDRESS)).toBe(true);
    expect(isGloballyRoutableIpv6('2001:4860:4860::8888')).toBe(true);
    for (const address of ['::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '3fff::1', '2002:808:808::1', '2001::1', '::ffff:8.8.8.8', '8.8.8.8']) {
      expect([address, isGloballyRoutableIpv6(address)]).toEqual([address, false]);
    }
  });
});

describe('the evidence keeps what IPv6 attribution needs', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const triggers = [read('database/migrations/001_baseline.sql').replace(/CREATE TRIGGER `(\w+)`/g, 'CREATE TRIGGER $1'), read('database/schema.sql')];

  test.each(['trg_connection_logs_after_insert_evidence', 'trg_connection_logs_after_update_evidence'])(
    '%s records the delegated prefix and the WAN address, hashed', (name) => {
      for (const source of triggers) {
        const start = source.lastIndexOf(`CREATE TRIGGER ${name}`);
        const body = source.slice(start, source.indexOf('\nEND', start));
        expect(body).toMatch(/framed_ipv6_prefix, delegated_ipv6_prefix, framed_ipv6_address,/);
        expect(body).toMatch(/'ipv6_delegated_prefix', NEW\.ipv6_delegated_prefix,\s+'ipv6_address', NEW\.ipv6_address,/);
        // Both go into the dedupe key the integrity hash covers.
        expect(body).toMatch(/NEW\.ipv6_delegated_prefix, NEW\.ipv6_address,\s+NEW\.bytes_in/);
      }
    },
  );

  test('a change of either writes new evidence', () => {
    for (const source of triggers) {
      const start = source.lastIndexOf('CREATE TRIGGER trg_connection_logs_after_update_evidence');
      const body = source.slice(start, source.indexOf('\nEND', start));
      expect(body).toMatch(/OR NOT \(NEW\.ipv6_delegated_prefix <=> OLD\.ipv6_delegated_prefix\)/);
      expect(body).toMatch(/OR NOT \(NEW\.ipv6_address <=> OLD\.ipv6_address\)/);
    }
  });

  test('case evidence takes an IPv6 address', () => {
    const baseline = require('./helpers/baseline').baselineColumns('ip_attribution_case_evidence');
    expect(baseline.get('evidence_type')).toMatch(/'direct_ipv6_assignment'/);
    expect(baseline.get('ip_address')).toMatch(/^varchar\(45\) .*DEFAULT NULL/);
    expect(baseline.get('public_ipv4')).toMatch(/^varchar\(15\) .*DEFAULT NULL/);
    const schema = read('database/schema.sql');
    const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS ip_attribution_case_evidence'));
    expect(table.slice(0, table.indexOf('ENGINE'))).toMatch(/'direct_ipv6_assignment'[\s\S]*ip_address VARCHAR\(45\) NULL[\s\S]*public_ipv4 VARCHAR\(15\) NULL/);
  });
});
