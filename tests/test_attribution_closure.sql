-- =============================================================================
-- VigaBSS 5.0 — Synthetic closures are evidenced at the last real accounting
-- =============================================================================
-- REG-01: when a Stop is lost and the subscriber reconnects (new MAC/NAS, or a
-- restarted session), the old lifecycle is closed synthetically. It used to be
-- stamped with the NEW Start's time, and the evidence trigger copied that into
-- the 'stop' evidence row, so IP lookups treated the old subscriber as certain
-- for the whole gap. The closure UPDATE (radiusAccountingService) now keeps
-- last_accounting_at; this checks the trigger evidences exactly that time.
--
-- Prerequisites: schema applied, test_helpers.sql loaded.
-- =============================================================================

SOURCE tests/test_helpers.sql;

CALL test_begin('Synthetic closure evidence (REG-01)');

INSERT INTO organizations (id, name, locale, status) VALUES (9100, 'Closure Test ISP', 'global', 'active');

-- A session that started at 09:00 and last reported (Interim) at 09:20.
INSERT INTO connection_logs
  (id, organization_id, contract_id, client_id, username, session_instance_id,
   acct_session_id, session_id, event_type, event_at, last_accounting_at,
   last_accounting_received_at, framed_ip, calling_station_id, attribution_evidence_complete)
VALUES
  (910001, 9100, 0, 0, 'closure-user', 'closure-0000-0000-0000-000000000001',
   'sess-old', 'sess-old', 'interim-update', '2026-08-14 09:00:00', '2026-08-14 09:20:00.000',
   '2026-08-14 09:20:01.000', '100.64.0.9', 'AA:AA:AA:AA:AA:AA', 1);

-- Its Stop was lost; the subscriber reconnects from another MAC at 10:00 and
-- the old lifecycle is closed exactly as radiusAccountingService does.
UPDATE connection_logs
   SET event_type = 'stop', terminate_cause = 'Session-Moved',
       last_accounting_at = COALESCE(last_accounting_at, event_at),
       last_accounting_received_at = '2026-08-14 10:00:00.000'
 WHERE id = 910001 AND organization_id = 9100 AND event_type != 'stop';

SELECT event_at INTO @closure_at
  FROM radius_accounting_events
 WHERE connection_log_id = 910001 AND status_type = 'stop'
 ORDER BY id DESC LIMIT 1;

CALL assert_true(@closure_at IS NOT NULL, 'R1: the synthetic closure is evidenced');
CALL assert_equal('2026-08-14 09:20:00', DATE_FORMAT(@closure_at, '%Y-%m-%d %H:%i:%s'), 'R1: closure evidenced at the last real accounting, not at the reconnect');

-- A real Stop for the old session, arriving later at 09:25, replaces it.
UPDATE connection_logs
   SET terminate_cause = 'Lost-Carrier', last_accounting_at = '2026-08-14 09:25:00.000',
       last_accounting_received_at = '2026-08-14 10:05:00.000'
 WHERE id = 910001 AND organization_id = 9100 AND event_type = 'stop';

SELECT event_at INTO @closure_at
  FROM radius_accounting_events
 WHERE connection_log_id = 910001 AND status_type = 'stop'
 ORDER BY event_at DESC, id DESC LIMIT 1;
CALL assert_equal('2026-08-14 09:25:00', DATE_FORMAT(@closure_at, '%Y-%m-%d %H:%i:%s'), 'R2: a later real Stop becomes the latest closure evidence');

DELETE FROM radius_accounting_events WHERE connection_log_id = 910001;
DELETE FROM connection_logs WHERE id = 910001;
DELETE FROM organizations WHERE id = 9100;

CALL test_summary();
