-- =============================================================================
-- Migration 504 — record a checksum for each applied migration (DB-21)
-- =============================================================================
-- schema_migrations held only the filename, so a shipped migration edited
-- after it ran went unnoticed. migrate.js stores the sha256 of each file's
-- SQL without comments and warns when an applied file has changed since.
-- The runner adds this column itself before it applies anything; this guarded
-- migration keeps the migrations and schema.sql in step.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_504_add_checksum;
DELIMITER //
CREATE PROCEDURE migration_504_add_checksum()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum'
  ) THEN
    ALTER TABLE schema_migrations
      ADD COLUMN checksum CHAR(64) NULL
        COMMENT 'sha256 of the SQL without comments when applied (migration 504)'
        AFTER applied_at;
  END IF;
END //
DELIMITER ;

CALL migration_504_add_checksum();
DROP PROCEDURE IF EXISTS migration_504_add_checksum;
