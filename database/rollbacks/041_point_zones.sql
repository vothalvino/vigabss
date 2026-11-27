-- Rollback 041 — points no longer belong to a zone, and the zones are dropped.

DROP PROCEDURE IF EXISTS r041_reseller_zone;
DELIMITER $$
CREATE PROCEDURE r041_reseller_zone()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND CONSTRAINT_NAME = 'fk_resellers_zone'
  ) THEN
    ALTER TABLE resellers DROP FOREIGN KEY fk_resellers_zone;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'zone_id'
  ) THEN
    ALTER TABLE resellers DROP KEY idx_resellers_zone, DROP COLUMN zone_id;
  END IF;
END $$
DELIMITER ;
CALL r041_reseller_zone();
DROP PROCEDURE IF EXISTS r041_reseller_zone;

DROP TABLE IF EXISTS point_zones;
