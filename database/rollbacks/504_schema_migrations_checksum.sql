-- =============================================================================
-- Rollback 504 — drop schema_migrations.checksum (DB-21)
-- =============================================================================
-- Roll back the application code with this: migrate.js adds the column back
-- on its next run. Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_504_drop_checksum;
DELIMITER //
CREATE PROCEDURE rollback_504_drop_checksum()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'
  ) THEN
    ALTER TABLE schema_migrations DROP COLUMN checksum;
  END IF;
END //
DELIMITER ;

CALL rollback_504_drop_checksum();
DROP PROCEDURE IF EXISTS rollback_504_drop_checksum;
