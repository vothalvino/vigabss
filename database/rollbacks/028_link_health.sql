-- Rollback 028 — drops the uplink port and capacity of each device. Lines of
-- the network tree are then judged without traffic or optical power.

DROP PROCEDURE IF EXISTS r028_link_health;
DELIMITER $$
CREATE PROCEDURE r028_link_health()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'uplink_capacity_mbps'
  ) THEN
    ALTER TABLE devices DROP COLUMN uplink_capacity_mbps;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'uplink_interface'
  ) THEN
    ALTER TABLE devices DROP COLUMN uplink_interface;
  END IF;
END $$
DELIMITER ;
CALL r028_link_health();
DROP PROCEDURE IF EXISTS r028_link_health;
