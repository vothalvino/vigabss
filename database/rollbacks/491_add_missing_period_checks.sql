-- =============================================================================
-- Rollback 491: drop the two period CHECK constraints
-- =============================================================================

-- DROP CONSTRAINT works on MySQL 8.0.19+ and MariaDB; DROP CHECK is MySQL-only.
ALTER TABLE ift_statistical_reports DROP CONSTRAINT chk_ift_statistical_reports_period;
ALTER TABLE regulatory_filings DROP CONSTRAINT chk_regulatory_filings_period;
