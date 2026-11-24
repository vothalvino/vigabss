-- =============================================================================
-- Migration 026 — a NAS can be a device on the network map
-- =============================================================================
-- Links, placement and the topology map work on devices. A NAS router lives
-- in its own table, so it could not be the end of a link. nas.device_id names
-- the device that represents the NAS on the map; it is created the first time
-- the NAS is linked to something.
--
-- Safe to re-run: the column, key and foreign key are added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m026_nas_device;
DELIMITER $$
CREATE PROCEDURE m026_nas_device()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'device_id'
  ) THEN
    ALTER TABLE nas
      ADD COLUMN device_id BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'devices.id that represents this NAS on the network map (migration 026)'
        AFTER site_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND INDEX_NAME = 'uq_nas_device'
  ) THEN
    ALTER TABLE nas ADD UNIQUE KEY uq_nas_device (device_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND CONSTRAINT_NAME = 'fk_nas_device'
  ) THEN
    ALTER TABLE nas
      ADD CONSTRAINT fk_nas_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL;
  END IF;
END $$
DELIMITER ;
CALL m026_nas_device();
DROP PROCEDURE IF EXISTS m026_nas_device;
