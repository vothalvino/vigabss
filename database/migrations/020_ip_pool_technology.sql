-- =============================================================================
-- Migration 020 — IP pools belong to an access technology
-- =============================================================================
-- A pool serves WISP subscribers, FTTH subscribers, or both. A new contract's
-- PPPoE account takes a pool of its own technology, so fibre and wireless
-- subscribers can be given separate address ranges.
--
--   ip_pools.access_technology  'wisp' | 'ftth' | 'both'   (default 'both')
--
-- Safe to re-run: the column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m020_ip_pool_technology;
DELIMITER $$
CREATE PROCEDURE m020_ip_pool_technology()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE ip_pools
      ADD COLUMN access_technology ENUM('wisp','ftth','both') NOT NULL DEFAULT 'both'
        COMMENT 'Subscribers of which access technology take addresses from this pool (migration 020)'
        AFTER service_type;
  END IF;
END $$
DELIMITER ;
CALL m020_ip_pool_technology();
DROP PROCEDURE IF EXISTS m020_ip_pool_technology;
