-- =============================================================================
-- VigaBSS 5.0 — Preservation holds keep a case's data from the purge (REG-06)
-- =============================================================================
-- Retention kept connection data only when an IP lookup had pinned evidence.
-- A case-scoped hold (preservation_holds) now keeps every matching row while
-- it is active. The predicate between the BEGIN/END markers is the one
-- retentionService adds to the connection_logs purge;
-- tests/preservationHolds.test.js fails if the two drift apart.
--
-- Prerequisites: schema applied, test_helpers.sql loaded.
-- =============================================================================

SOURCE tests/test_helpers.sql;

CALL test_begin('Preservation holds (REG-06)');

INSERT INTO organizations (id, name, locale, status) VALUES (9200, 'Hold Test ISP', 'global', 'active');
INSERT INTO gov_data_requests (id, organization_id, authority_name, authority_ref, request_type, status, date_from, date_to)
VALUES (920001, 9200, 'Fiscalía', 'FGR/2026/001', 'subscriber_data', 'processing', '2026-01-01', '2026-01-31');

-- Two sessions in January: one of the held subscriber, one of someone else.
INSERT INTO connection_logs
  (id, organization_id, contract_id, client_id, username, session_instance_id,
   acct_session_id, session_id, event_type, event_at, last_accounting_at,
   last_accounting_received_at, framed_ip, calling_station_id, attribution_evidence_complete)
VALUES
  (920001, 9200, 0, 0, 'held-user', 'hold-0000-0000-0000-000000000001',
   'sess-held', 'sess-held', 'stop', '2026-01-10 09:00:00', '2026-01-10 10:00:00.000',
   '2026-01-10 10:00:01.000', '100.64.0.10', 'AA:AA:AA:AA:AA:10', 1),
  (920002, 9200, 0, 0, 'free-user', 'hold-0000-0000-0000-000000000002',
   'sess-free', 'sess-free', 'stop', '2026-01-10 09:00:00', '2026-01-10 10:00:00.000',
   '2026-01-10 10:00:01.000', '100.64.0.11', 'AA:AA:AA:AA:AA:11', 1);

INSERT INTO preservation_holds (id, organization_id, gov_data_request_id, username, held_from, held_to, reason)
VALUES (920001, 9200, 920001, 'held-user', '2026-01-01 00:00:00.000', '2026-01-31 23:59:59.999', 'Case FGR/2026/001');

-- The purge, limited to this test's rows.
DELETE FROM connection_logs
 WHERE organization_id = 9200 AND id IN (920001, 920002)
   AND (
-- BEGIN connection_logs preservation predicate
NOT EXISTS (
      SELECT 1 FROM preservation_holds ph
       WHERE ph.organization_id = connection_logs.organization_id
         AND ph.released_at IS NULL
         AND ph.held_from <= COALESCE(connection_logs.last_accounting_at, connection_logs.event_at)
         AND (ph.held_to IS NULL OR ph.held_to >= connection_logs.event_at)
         AND ((ph.client_id IS NOT NULL AND ph.client_id = connection_logs.client_id)
           OR (ph.contract_id IS NOT NULL AND ph.contract_id = connection_logs.contract_id)
           OR (ph.username IS NOT NULL AND ph.username = connection_logs.username)
           OR (ph.ip_address IS NOT NULL AND ph.ip_address IN (connection_logs.framed_ip, connection_logs.ip_address)))
    )
-- END connection_logs preservation predicate
   );

SELECT COUNT(*) INTO @held FROM connection_logs WHERE id = 920001 AND organization_id = 9200;
SELECT COUNT(*) INTO @free FROM connection_logs WHERE id = 920002 AND organization_id = 9200;
CALL assert_equal('1', @held, 'P1: the held subscriber''s session survives the purge');
CALL assert_equal('0', @free, 'P1: an unheld session in the same range is purged');

-- A hold whose range ends before the session does not keep it.
UPDATE preservation_holds SET held_to = '2026-01-05 00:00:00.000' WHERE id = 920001;
SELECT COUNT(*) INTO @covered FROM connection_logs cl
 WHERE cl.id = 920001 AND NOT EXISTS (
   SELECT 1 FROM preservation_holds ph
    WHERE ph.organization_id = cl.organization_id AND ph.released_at IS NULL
      AND ph.held_from <= COALESCE(cl.last_accounting_at, cl.event_at)
      AND (ph.held_to IS NULL OR ph.held_to >= cl.event_at)
      AND ph.username = cl.username);
CALL assert_equal('1', @covered, 'P2: a hold covers only sessions overlapping its range');
UPDATE preservation_holds SET held_to = '2026-01-31 23:59:59.999' WHERE id = 920001;

-- Released, the row is purged on the next run.
UPDATE preservation_holds SET released_at = NOW(3), release_reason = 'Case closed' WHERE id = 920001;
DELETE FROM connection_logs
 WHERE organization_id = 9200 AND id = 920001
   AND NOT EXISTS (
      SELECT 1 FROM preservation_holds ph
       WHERE ph.organization_id = connection_logs.organization_id
         AND ph.released_at IS NULL
         AND ph.username = connection_logs.username);
SELECT COUNT(*) INTO @held FROM connection_logs WHERE id = 920001 AND organization_id = 9200;
CALL assert_equal('0', @held, 'P3: a released hold no longer keeps the session');

-- A hold needs exactly one case and a subject.
CALL assert_sql_error(NULL,
  'INSERT INTO preservation_holds (organization_id, username, held_from, reason) VALUES (9200, ''x'', ''2026-01-01'', ''no case'')',
  'P4: a hold without a case is refused');
CALL assert_sql_error(NULL,
  'INSERT INTO preservation_holds (organization_id, gov_data_request_id, held_from, reason) VALUES (9200, 920001, ''2026-01-01'', ''no subject'')',
  'P4: a hold without a subject is refused');
CALL assert_sql_error(NULL,
  'INSERT INTO preservation_holds (organization_id, gov_data_request_id, username, held_from, held_to, reason) VALUES (9200, 920001, ''x'', ''2026-02-01'', ''2026-01-01'', ''backwards'')',
  'P4: a hold ending before it starts is refused');

DELETE FROM radius_accounting_events WHERE connection_log_id IN (920001, 920002);
DELETE FROM connection_logs WHERE id IN (920001, 920002);
DELETE FROM preservation_holds WHERE organization_id = 9200;
DELETE FROM gov_data_requests WHERE id = 920001;
DELETE FROM organizations WHERE id = 9200;

CALL test_summary();
