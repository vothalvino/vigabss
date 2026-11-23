-- Rollback 018 — drops plans.access_technology and contracts.access_technology.
-- Which plans and contracts are FTTH is lost; the earlier code treats every
-- contract as WISP.

DROP PROCEDURE IF EXISTS r018_access_technology;
DELIMITER $$
CREATE PROCEDURE r018_access_technology()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE contracts DROP COLUMN access_technology;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans' AND COLUMN_NAME = 'access_technology'
  ) THEN
    ALTER TABLE plans DROP COLUMN access_technology;
  END IF;
END $$
DELIMITER ;
CALL r018_access_technology();
DROP PROCEDURE IF EXISTS r018_access_technology;
