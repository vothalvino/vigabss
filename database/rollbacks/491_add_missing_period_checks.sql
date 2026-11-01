-- =============================================================================
-- Rollback 491: drop the two period CHECK constraints
-- =============================================================================

ALTER TABLE ift_statistical_reports DROP CHECK chk_ift_statistical_reports_period;
ALTER TABLE regulatory_filings DROP CHECK chk_regulatory_filings_period;
