-- =============================================================================
-- Rollback 479 — restore the generated retention_at column
-- =============================================================================
-- Brings back migration 457's STORED generated column and its original
-- trigger. On MySQL 8.4 that combination rejects every connection_logs
-- INSERT again (see migration 479); roll back the application with this only
-- on a server where that is known not to happen.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_connection_logs_before_update_retention;

DROP PROCEDURE IF EXISTS rollback_479_connection_logs_retention_column;
DELIMITER //
CREATE PROCEDURE rollback_479_connection_logs_retention_column()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs'
       AND COLUMN_NAME = 'retention_at' AND EXTRA NOT LIKE '%GENERATED%'
  ) THEN
    ALTER TABLE connection_logs
      DROP KEY idx_conn_logs_retention,
      DROP KEY idx_conn_logs_org_retention,
      DROP COLUMN retention_at;
    ALTER TABLE connection_logs
      ADD COLUMN retention_at DATETIME(3) GENERATED ALWAYS AS (COALESCE(last_accounting_received_at, last_accounting_at, event_at)) STORED,
      ADD KEY idx_conn_logs_retention (retention_at),
      ADD KEY idx_conn_logs_org_retention (organization_id, retention_at);
  END IF;
END //
DELIMITER ;

CALL rollback_479_connection_logs_retention_column();
DROP PROCEDURE IF EXISTS rollback_479_connection_logs_retention_column;

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
END //
DELIMITER ;
