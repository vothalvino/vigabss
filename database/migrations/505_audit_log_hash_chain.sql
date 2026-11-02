-- =============================================================================
-- Migration 505 — hash chain over audit_logs (ASY-38)
-- =============================================================================
-- The immutability triggers stop the application from editing or deleting
-- audit rows, but a database administrator can drop the triggers, change a
-- row and recreate them without a trace. Each organization's audit rows (and
-- the install-wide rows, organization_id NULL) now form a hash chain: every
-- row stores its position in the chain, the previous row's hash and its own
-- hash over its content. Changing, removing or reordering a row breaks the
-- chain, which GET /audit-logs/verify reports.
--
-- audit_log_chain holds each chain's head. The BEFORE INSERT trigger locks the
-- head row, so concurrent inserts into one chain are serialized and the chain
-- order is the commit order. A rolled-back insert also rolls back the head.
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_log_chain (
    chain_key  BIGINT UNSIGNED NOT NULL COMMENT 'organization_id, or 0 for install-wide events',
    last_seq   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'chain_seq of the newest row',
    last_hash  CHAR(64)        NOT NULL COMMENT 'row_hash of the newest row',
    updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (chain_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Head of each audit_logs hash chain (migration 505)';

DROP PROCEDURE IF EXISTS migration_505_add_chain_columns;
DELIMITER //
CREATE PROCEDURE migration_505_add_chain_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'chain_seq'
  ) THEN
    ALTER TABLE audit_logs
      ADD COLUMN chain_seq BIGINT UNSIGNED NULL
        COMMENT 'Position in the organization''s audit hash chain (migration 505)' AFTER created_at,
      ADD COLUMN prev_hash CHAR(64) NULL
        COMMENT 'row_hash of the previous row in the chain' AFTER chain_seq,
      ADD COLUMN row_hash CHAR(64) NULL
        COMMENT 'audit_log_row_hash() over this row and prev_hash' AFTER prev_hash;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_logs_chain'
  ) THEN
    ALTER TABLE audit_logs ADD KEY idx_audit_logs_chain (organization_id, chain_seq);
  END IF;
END //
DELIMITER ;

CALL migration_505_add_chain_columns();
DROP PROCEDURE IF EXISTS migration_505_add_chain_columns;

DELIMITER //

-- One definition of a row's hash, used by the trigger and the verifier. The
-- time is hashed as a Unix timestamp so the session time zone cannot change it.
DROP FUNCTION IF EXISTS audit_log_row_hash //
CREATE FUNCTION audit_log_row_hash(
    p_prev_hash   CHAR(64),
    p_chain_seq   BIGINT UNSIGNED,
    p_org_id      BIGINT UNSIGNED,
    p_user_id     BIGINT UNSIGNED,
    p_action      VARCHAR(40),
    p_entity_type VARCHAR(50),
    p_entity_id   BIGINT UNSIGNED,
    p_summary     VARCHAR(500),
    p_old_values  JSON,
    p_new_values  JSON,
    p_ip_address  VARCHAR(45),
    p_user_agent  VARCHAR(500),
    p_created_at  TIMESTAMP
)
RETURNS CHAR(64)
DETERMINISTIC
NO SQL
RETURN SHA2(CAST(JSON_ARRAY(
    p_prev_hash, p_chain_seq, p_org_id, p_user_id, p_action, p_entity_type,
    p_entity_id, p_summary, p_old_values, p_new_values, p_ip_address,
    p_user_agent, UNIX_TIMESTAMP(p_created_at)
) AS CHAR), 256) //

DROP TRIGGER IF EXISTS trg_audit_logs_chain_bi //
CREATE TRIGGER trg_audit_logs_chain_bi
BEFORE INSERT ON audit_logs
FOR EACH ROW
BEGIN
    DECLARE v_key BIGINT UNSIGNED DEFAULT COALESCE(NEW.organization_id, 0);
    DECLARE v_seq BIGINT UNSIGNED;
    DECLARE v_prev CHAR(64);

    INSERT INTO audit_log_chain (chain_key, last_seq, last_hash)
    VALUES (v_key, 0, REPEAT('0', 64))
    ON DUPLICATE KEY UPDATE chain_key = chain_key;

    SELECT last_seq, last_hash INTO v_seq, v_prev
      FROM audit_log_chain WHERE chain_key = v_key FOR UPDATE;

    SET NEW.created_at = COALESCE(NEW.created_at, CURRENT_TIMESTAMP);
    SET NEW.chain_seq = v_seq + 1;
    SET NEW.prev_hash = v_prev;
    SET NEW.row_hash = audit_log_row_hash(
        NEW.prev_hash, NEW.chain_seq, NEW.organization_id, NEW.user_id, NEW.action,
        NEW.entity_type, NEW.entity_id, NEW.summary, NEW.old_values, NEW.new_values,
        NEW.ip_address, NEW.user_agent, NEW.created_at);

    UPDATE audit_log_chain SET last_seq = NEW.chain_seq, last_hash = NEW.row_hash
     WHERE chain_key = v_key;
END //

DELIMITER ;
