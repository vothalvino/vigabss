-- =============================================================================
-- Rollback 508 — AI usage ledger and monthly budget (ASY-34)
-- =============================================================================
-- Roll back the application code with this. Safe to re-run.
-- =============================================================================

DROP TABLE IF EXISTS ai_usage_events;

DROP PROCEDURE IF EXISTS rollback_508_ai_budget;
DELIMITER //
CREATE PROCEDURE rollback_508_ai_budget()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_policies' AND COLUMN_NAME = 'monthly_budget_usd'
  ) THEN
    ALTER TABLE ai_policies DROP COLUMN monthly_budget_usd;
  END IF;
END //
DELIMITER ;

CALL rollback_508_ai_budget();
DROP PROCEDURE IF EXISTS rollback_508_ai_budget;
