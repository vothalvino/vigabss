'use strict';

// REG-01: a certain direct match must not be returned while another session
// row for the same address could also cover the instant.

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
  withPrimaryContext: jest.fn(callback => callback()),
}));
jest.mock('../src/models/User', () => ({ getPermissions: jest.fn() }));
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn().mockResolvedValue({ id: 50 }),
}));

const db = require('../src/config/database');
const { lookupAttribution } = require('../src/services/cgnatAttributionService');
const { governmentRequestRowHash } = require('../src/utils/govDataRequestIntegrity');

const ORGANIZATION_ID = 10;
const OBSERVED_AT = '2026-08-01T00:30:00.000Z';

function requestCase({ cgnat = false, observedAt = OBSERVED_AT } = {}) {
  const row = {
    id: 81,
    organization_id: ORGANIZATION_ID,
    request_type: 'ip_traceability',
    status: 'processing',
    authority_name: 'Authority',
    authority_ref: 'AUTH-1',
    legal_basis: 'Exact source attribution request',
    legal_reviewed_at: new Date('2026-07-31T00:00:00.000Z'),
    legal_reviewed_by: 1,
    client_id: null,
    contract_id: null,
    ip_address: '8.8.8.8',
    public_port: cgnat ? 45000 : null,
    protocol: cgnat ? 'tcp' : null,
    observed_at: new Date(observedAt),
    created_at: new Date('2026-07-31T00:00:00.000Z'),
  };
  row.row_hash = governmentRequestRowHash(row);
  return row;
}

function lookupBody({ cgnat = false, observedAt = OBSERVED_AT } = {}) {
  return {
    gov_data_request_id: 81,
    public_ipv4: '8.8.8.8',
    ...(cgnat ? { public_port: 45000, protocol: 'tcp' } : {}),
    observed_at: observedAt,
  };
}

function directRow(overrides = {}) {
  return {
    connection_log_id: 31,
    client_id: 41,
    contract_id: 51,
    username: 'subscriber-1',
    radius_session_id: 'radius-1',
    session_instance_id: '11111111-1111-4111-8111-111111111111',
    public_ipv4: '8.8.8.8',
    assigned_at: new Date('2026-08-01T00:05:00.000Z'),
    assignment_evidence_id: 61,
    assignment_evidence_event_at: new Date('2026-08-01T00:05:00.000Z'),
    assignment_evidence_received_at: new Date('2026-08-01T00:07:00.000Z'),
    assignment_evidence_integrity_hash: 'a'.repeat(64),
    closure_evidence_id: null,
    released_at: null,
    closure_evidence_received_at: null,
    closure_evidence_integrity_hash: null,
    last_accounting_at: new Date('2026-08-01T00:45:00.000Z'),
    last_accounting_received_at: new Date('2026-08-01T00:40:00.000Z'),
    client_name: 'Subscriber One',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

function databaseWith(blockers) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM gov_data_requests/.test(sql)) return [[requestCase()]];
    if (/SELECT COUNT\(\*\) AS blockers/.test(sql)) return [[{ blockers }]];
    if (/FROM connection_logs cl/.test(sql)) return [[directRow()]];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
}

describe('overlapping unverified sessions', () => {
  test('one certain session and no competing row is matched', async () => {
    databaseWith(0);
    const result = await lookupAttribution(ORGANIZATION_ID, lookupBody(), { pin: false });
    expect(result).toMatchObject({ status: 'matched', attributionMethod: 'direct_public_assignment' });
  });

  test('another row that could cover the instant makes the answer ambiguous', async () => {
    databaseWith(1);
    const result = await lookupAttribution(ORGANIZATION_ID, lookupBody(), { pin: false });
    expect(result).toMatchObject({
      status: 'ambiguous', reason: 'overlapping_unverified_session', candidate_count: 2, attributionMethod: null,
    });
    expect(result).not.toHaveProperty('attribution');
  });

  test('the competing-row check covers closed rows reaching the instant and open rows started after the match', async () => {
    databaseWith(0);
    await lookupAttribution(ORGANIZATION_ID, lookupBody(), { pin: false });
    const [sql, params] = db.query.mock.calls.find(([q]) => /AS blockers/.test(q));
    expect(sql).toMatch(/cl\.id <> \?/);
    expect(sql).toMatch(/cl\.event_type = 'stop' AND COALESCE\(cl\.last_accounting_at, cl\.event_at\) >= \?/);
    expect(sql).toMatch(/cl\.event_type <> 'stop' AND cl\.event_at >= \?/);
    // No filter on attribution_evidence_complete or session_instance_id: those
    // are exactly the rows the certain search skips.
    expect(sql).not.toMatch(/attribution_evidence_complete|session_instance_id IS NOT NULL/);
    expect(params).toEqual([
      ORGANIZATION_ID, '8.8.8.8', 31, new Date(OBSERVED_AT), new Date(OBSERVED_AT),
      new Date('2026-08-01T00:05:00.000Z'),
    ]);
  });
});
