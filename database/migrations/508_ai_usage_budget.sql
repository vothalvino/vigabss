-- =============================================================================
-- Migration 508 — AI usage ledger and monthly budget (ASY-34)
-- =============================================================================
-- Nothing capped AI spend: every portal chat message and ticket could call the
-- provider, and the only cost record (ai_reply_logs) covered ticket replies.
-- ai_usage_events records the cost of every chat and embedding call, and
-- ai_policies.monthly_budget_usd (NULL = no limit) caps the month-to-date sum.
-- Re-runnable: the table and column are guarded.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_usage_events (
    id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED  NOT NULL,
    ai_provider_id      BIGINT UNSIGNED  NULL,
    operation           ENUM('chat','embed') NOT NULL,
    prompt_tokens       INT UNSIGNED     NULL,
    completion_tokens   INT UNSIGNED     NULL,
    cost_usd            DECIMAL(12,6)    NULL COMMENT 'NULL when the provider price is unknown',
    created_at          TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_ai_usage_events_org_created (organization_id, created_at),
    CONSTRAINT fk_ai_usage_events_org
        FOREIGN KEY (organization_id) REFERENCES organizations (id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Cost of each AI provider call, for the monthly budget (ASY-34)';

DROP PROCEDURE IF EXISTS migration_508_ai_budget;
DELIMITER //
CREATE PROCEDURE migration_508_ai_budget()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_policies' AND COLUMN_NAME = 'monthly_budget_usd'
  ) THEN
    ALTER TABLE ai_policies
      ADD COLUMN monthly_budget_usd DECIMAL(10,2) NULL
        COMMENT 'Month-to-date AI spend cap in USD; NULL = no limit (migration 508)'
        AFTER active_provider_id;
  END IF;
END //
DELIMITER ;

CALL migration_508_ai_budget();
DROP PROCEDURE IF EXISTS migration_508_ai_budget;
