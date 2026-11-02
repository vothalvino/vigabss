-- =============================================================================
-- Rollback 505 — remove the audit_logs hash chain (ASY-38)
-- =============================================================================
-- Drops the chain trigger, function, head table and columns. The chain
-- columns cannot be dropped while the immutability trigger blocks UPDATE; an
-- ALTER TABLE does not fire row triggers, so the drop is allowed. The chain
-- evidence of every existing row is lost. Roll back the application code with
-- this. Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_audit_logs_chain_bi;
DROP FUNCTION IF EXISTS audit_log_row_hash;
DROP TABLE IF EXISTS audit_log_chain;

DROP PROCEDURE IF EXISTS rollback_505_drop_chain_columns;
DELIMITER //
CREATE PROCEDURE rollback_505_drop_chain_columns()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_logs_chain'
  ) THEN
    ALTER TABLE audit_logs DROP KEY idx_audit_logs_chain;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'chain_seq'
  ) THEN
    ALTER TABLE audit_logs DROP COLUMN row_hash, DROP COLUMN prev_hash, DROP COLUMN chain_seq;
  END IF;
END //
DELIMITER ;

CALL rollback_505_drop_chain_columns();
DROP PROCEDURE IF EXISTS rollback_505_drop_chain_columns;
