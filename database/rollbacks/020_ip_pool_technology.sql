-- Rollback 020 — drops ip_pools.access_technology. Pools are no longer tied
-- to a technology; a new contract takes the organization's first active pool.

DROP PROCEDURE IF EXISTS r020_ip_pool_technology;
DELIMITER $$
CREATE PROCEDURE r020_ip_pool_technology()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE ip_pools DROP COLUMN access_technology;
  END IF;
END $$
DELIMITER ;
CALL r020_ip_pool_technology();
DROP PROCEDURE IF EXISTS r020_ip_pool_technology;
