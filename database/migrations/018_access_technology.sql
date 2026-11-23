-- =============================================================================
-- Migration 018 — access technology on plans and contracts (WISP / FTTH)
-- =============================================================================
-- A plan is offered over wireless (WISP), fibre (FTTH) or both. A contract
-- is written for one technology, chosen when it is created:
--
--   plans.access_technology      'wisp' | 'ftth' | 'both'   (default 'wisp')
--   contracts.access_technology  'wisp' | 'ftth' | NULL
--
-- NULL is only found on contracts from before this migration; they follow
-- their plan (FTTH for an FTTH-only plan, WISP otherwise), so every existing
-- plan and contract stays WISP, which is how they are served today.
--
-- Safe to re-run: each column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m018_access_technology;
DELIMITER $$
CREATE PROCEDURE m018_access_technology()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE plans
      ADD COLUMN access_technology ENUM('wisp','ftth','both') NOT NULL DEFAULT 'wisp'
        COMMENT 'Access technology this plan is offered over: wireless, fibre or both (migration 018)'
        AFTER stack_type;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN access_technology ENUM('wisp','ftth') NULL DEFAULT NULL
        COMMENT 'Technology this contract was written for; NULL (older contracts) = as its plan says (migration 018)'
        AFTER connection_type;
  END IF;
END $$
DELIMITER ;
CALL m018_access_technology();
DROP PROCEDURE IF EXISTS m018_access_technology;
