'use strict';
// =============================================================================
// IPv6 legal attribution against a real database (migration 524)
// =============================================================================
// The mocked tests check the SQL's shape; this runs it. A session row is
// inserted the way ingest leaves it, so the real evidence triggers write the
// append-only rows (now carrying the delegated prefix and the WAN address),
// and an approved ip_traceability case is looked up by an address inside the
// delegated prefix: matched once, ambiguous when a nested prefix routed to
// another session also holds it.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const crypto = require('crypto');
const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9301;
const DELEGATED = '2806:2f0:abcd::/48';
const NESTED = '2806:2f0:abcd:7::/64';
const ADDRESS = '2806:2f0:abcd:7::25';

describeDb('IPv6 legal attribution against a real database', () => {
  let db;
  let service;
  let governmentRequestRowHash;
  let actorId;
  let observedAt;

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    service = require('../../../src/services/cgnatAttributionService');
    ({ governmentRequestRowHash } = require('../../../src/utils/govDataRequestIntegrity'));
    actorId = (await createOrgAdmin(db, ORG, 'IPV6')).userId;
    // The instant the authority names: five minutes ago, to the millisecond.
    observedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60 * 1000);
  }, 120000);

  afterAll(teardown);

  async function session({ contractId, prefix, wan }) {
    const assigned = new Date(observedAt.getTime() - 10 * 60 * 1000);
    const instance = crypto.randomUUID();
    const [result] = await db.query(
      `INSERT INTO connection_logs
         (organization_id, username, contract_id, client_id, session_instance_id, acct_session_id,
          event_type, event_at, last_accounting_at, last_accounting_received_at,
          ipv6_delegated_prefix, ipv6_address, attribution_evidence_complete)
       VALUES (?, ?, ?, ?, ?, ?, 'start', ?, ?, ?, ?, ?, 1)`,
      [ORG, `v6-${contractId}`, contractId, contractId + 1000, instance, `acct-${contractId}`,
        assigned, assigned, assigned, prefix, wan],
    );
    // Later accounting keeps the session live; it changes no identity, so it
    // writes no new evidence row.
    await db.query(
      'UPDATE connection_logs SET last_accounting_at = NOW(3), last_accounting_received_at = NOW(3) WHERE id = ? AND organization_id = ?',
      [result.insertId, ORG],
    );
    return { id: result.insertId, instance };
  }

  async function approvedCase(address) {
    const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const row = {
      organization_id: ORG, authority_name: 'Fiscalía de prueba', authority_ref: `V6-${createdAt.getTime()}`,
      request_type: 'ip_traceability', client_id: null, contract_id: null, ip_address: address,
      public_port: null, protocol: null, observed_at: observedAt,
      legal_basis: 'Written, grounded authority request for this exact address and time', created_at: createdAt,
    };
    const [result] = await db.query(
      `INSERT INTO gov_data_requests
         (organization_id, authority_name, authority_ref, request_type, client_id, contract_id,
          ip_address, public_port, protocol, observed_at, legal_basis, status, row_hash, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, 'processing', ?, ?)`,
      [ORG, row.authority_name, row.authority_ref, row.request_type, row.ip_address, row.observed_at,
        row.legal_basis, governmentRequestRowHash(row), createdAt],
    );
    return result.insertId;
  }

  test('the evidence triggers record the delegated prefix and the WAN address', async () => {
    const { instance } = await session({ contractId: 9311, prefix: DELEGATED, wan: '2806:2f0:ff::9' });
    const [[evidence]] = await db.query(
      `SELECT delegated_ipv6_prefix, framed_ipv6_address, integrity_hash
         FROM radius_accounting_events WHERE organization_id = ? AND session_instance_id = ?`,
      [ORG, instance],
    );
    expect(evidence).toMatchObject({ delegated_ipv6_prefix: DELEGATED, framed_ipv6_address: '2806:2f0:ff::9' });
    expect(evidence.integrity_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('an address inside the delegated prefix is attributed, and the evidence pinned', async () => {
    const caseId = await approvedCase(ADDRESS);
    const result = await service.lookupAttribution(ORG, { gov_data_request_id: caseId, ip_address: ADDRESS, observed_at: observedAt.toISOString() }, { actorId });

    expect(result).toMatchObject({
      status: 'matched', attributionMethod: 'direct_ipv6_assignment',
      attribution: { contract_id: 9311, ip_address: ADDRESS, ip_version: 6, ipv6_matched_by: 'ipv6_delegated_prefix', ipv6_delegated_prefix: DELEGATED },
    });
    const [[pinned]] = await db.query(
      'SELECT evidence_type, ip_address, public_ipv4 FROM ip_attribution_case_evidence WHERE organization_id = ? AND gov_data_request_id = ?',
      [ORG, caseId],
    );
    expect(pinned).toEqual({ evidence_type: 'direct_ipv6_assignment', ip_address: ADDRESS, public_ipv4: null });
  });

  test('a nested prefix routed to another session makes it ambiguous', async () => {
    await session({ contractId: 9312, prefix: NESTED, wan: '2806:2f0:ff::10' });
    const caseId = await approvedCase(ADDRESS);
    const result = await service.lookupAttribution(ORG, { gov_data_request_id: caseId, ip_address: ADDRESS, observed_at: observedAt.toISOString() }, { pin: false });

    expect(result.status).toBe('ambiguous');
    expect(result).not.toHaveProperty('attribution');
  });
});
