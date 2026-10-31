-- =============================================================================
-- Migration 479 — connection_logs accepts inserts again on MySQL 8.4
-- =============================================================================
-- Migration 457 gave the partitioned connection_logs table both a STORED
-- generated column (retention_at) and a BEFORE INSERT trigger
-- (trg_connection_logs_before_insert_org). On MySQL 8.4 that combination
-- rejects every INSERT under the default strict SQL mode:
--   ERROR 1292: Incorrect datetime value '0000-00-00 00:00:00.000' for column
--   'retention_at'
-- (shown in CI: a partitioned copy of the table without the trigger accepts
-- the row; the same copy with a no-op BEFORE INSERT trigger rejects it). So
-- every accounting Start, and with it session history, usage and
-- lawful-intercept evidence, has failed to record since 457.
--
-- retention_at becomes an ordinary column kept by the triggers: the insert
-- trigger sets it, and a new BEFORE UPDATE trigger keeps it current. Same
-- value, same indexes. Existing rows are backfilled.
--
-- The guarded procedure makes the migration safe to resume after interrupted
-- MySQL DDL.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_479_connection_logs_retention_column;
DELIMITER //
CREATE PROCEDURE migration_479_connection_logs_retention_column()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs'
       AND COLUMN_NAME = 'retention_at' AND EXTRA LIKE '%GENERATED%'
  ) THEN
    ALTER TABLE connection_logs
      DROP KEY idx_conn_logs_retention,
      DROP KEY idx_conn_logs_org_retention,
      DROP COLUMN retention_at;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs' AND COLUMN_NAME = 'retention_at'
  ) THEN
    ALTER TABLE connection_logs
      ADD COLUMN retention_at DATETIME(3) NULL
        COMMENT 'Indexed latest activity used by application retention; kept by the connection_logs triggers (migrations 457, 479)',
      ADD KEY idx_conn_logs_retention (retention_at),
      ADD KEY idx_conn_logs_org_retention (organization_id, retention_at);
  END IF;
END //
DELIMITER ;

CALL migration_479_connection_logs_retention_column();
DROP PROCEDURE IF EXISTS migration_479_connection_logs_retention_column;

UPDATE connection_logs
   SET retention_at = COALESCE(last_accounting_received_at, last_accounting_at, event_at)
 WHERE retention_at IS NULL;

DROP TRIGGER IF EXISTS trg_connection_logs_before_insert_org;
DELIMITER //
CREATE TRIGGER trg_connection_logs_before_insert_org
BEFORE INSERT ON connection_logs
FOR EACH ROW
BEGIN
  DECLARE v_nas_org BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_contract_org BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_client_org BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_nas_ip_org BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_candidate BIGINT UNSIGNED DEFAULT NULL;
  IF NEW.nas_id IS NOT NULL THEN
    SELECT MAX(n.organization_id) INTO v_nas_org FROM nas n WHERE n.id = NEW.nas_id AND n.organization_id IS NOT NULL;
  END IF;
  IF NEW.contract_id <> 0 THEN
    SELECT MAX(c.organization_id) INTO v_contract_org FROM contracts c WHERE c.id = NEW.contract_id AND c.organization_id IS NOT NULL;
  END IF;
  IF NEW.client_id <> 0 THEN
    SELECT MAX(c.organization_id) INTO v_client_org FROM clients c WHERE c.id = NEW.client_id AND c.organization_id IS NOT NULL;
  END IF;
  IF NEW.nas_ip_address IS NOT NULL THEN
    SELECT IF(COUNT(DISTINCT n.organization_id) = 1, MIN(n.organization_id), NULL) INTO v_nas_ip_org
      FROM nas n WHERE n.ip_address = NEW.nas_ip_address AND n.organization_id IS NOT NULL AND n.deleted_at IS NULL;
  END IF;
  SET v_candidate = COALESCE(v_nas_org, v_contract_org, v_client_org, v_nas_ip_org);
  IF v_candidate IS NOT NULL AND (
       (v_nas_org IS NOT NULL AND v_nas_org <> v_candidate)
    OR (v_contract_org IS NOT NULL AND v_contract_org <> v_candidate)
    OR (v_client_org IS NOT NULL AND v_client_org <> v_candidate)
    OR (v_nas_ip_org IS NOT NULL AND v_nas_ip_org <> v_candidate)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Connection log tenant anchors disagree';
  END IF;
  IF NEW.organization_id IS NOT NULL AND v_candidate IS NOT NULL AND NEW.organization_id <> v_candidate THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Connection log organization does not own its anchors';
  END IF;
  IF NEW.organization_id IS NULL THEN SET NEW.organization_id = v_candidate; END IF;
  -- retention_at is maintained here, not as a STORED generated column (migration 479).
  SET NEW.retention_at = COALESCE(NEW.last_accounting_received_at, NEW.last_accounting_at, NEW.event_at);
END //
DELIMITER ;

DROP TRIGGER IF EXISTS trg_connection_logs_before_update_retention;
DELIMITER //
CREATE TRIGGER trg_connection_logs_before_update_retention
BEFORE UPDATE ON connection_logs
FOR EACH ROW
BEGIN
  SET NEW.retention_at = COALESCE(NEW.last_accounting_received_at, NEW.last_accounting_at, NEW.event_at);
END //
DELIMITER ;
