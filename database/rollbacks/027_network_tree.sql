-- Rollback 027 — drops nas.is_main and removes the 'battery_monitor' device
-- type. Which NAS routers were main is lost. Devices of type battery_monitor
-- become 'other' first, since the narrower list cannot hold them.

UPDATE devices SET type = 'other' WHERE type = 'battery_monitor';

DROP PROCEDURE IF EXISTS r027_network_tree;
DELIMITER $$
CREATE PROCEDURE r027_network_tree()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'type'
       AND COLUMN_TYPE LIKE '%battery_monitor%'
  ) THEN
    ALTER TABLE devices
      MODIFY COLUMN type ENUM('outdoor_cpe','indoor_cpe','ptp','ptmp_ap','olt','router','switch','onu','other')
        NOT NULL DEFAULT 'other'
        COMMENT 'Device type — client: outdoor_cpe, indoor_cpe; pop: ptp, ptmp_ap, olt, router, switch, onu';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'is_main'
  ) THEN
    ALTER TABLE nas DROP COLUMN is_main;
  END IF;
END $$
DELIMITER ;
CALL r027_network_tree();
DROP PROCEDURE IF EXISTS r027_network_tree;
