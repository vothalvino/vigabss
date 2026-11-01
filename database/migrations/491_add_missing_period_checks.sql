-- =============================================================================
-- Migration 491 — period CHECK constraints that only schema.sql had
-- =============================================================================
-- schema.sql declares chk_ift_statistical_reports_period and
-- chk_regulatory_filings_period, but no migration ever created them, so a
-- database built by the migration runner (every real install) accepted an IFT
-- report or a regulatory filing whose period ends before it starts. Running
-- the SQL test suite against the migrated database surfaced the gap (DB-09).
-- Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_491_add_missing_period_checks;
DELIMITER //
CREATE PROCEDURE migration_491_add_missing_period_checks()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ift_statistical_reports'
      AND CONSTRAINT_NAME = 'chk_ift_statistical_reports_period'
  ) THEN
    ALTER TABLE ift_statistical_reports
      ADD CONSTRAINT chk_ift_statistical_reports_period CHECK (period_end >= period_start);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'regulatory_filings'
      AND CONSTRAINT_NAME = 'chk_regulatory_filings_period'
  ) THEN
    ALTER TABLE regulatory_filings
      ADD CONSTRAINT chk_regulatory_filings_period
      CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start);
  END IF;
END //
DELIMITER ;

CALL migration_491_add_missing_period_checks();
DROP PROCEDURE IF EXISTS migration_491_add_missing_period_checks;
