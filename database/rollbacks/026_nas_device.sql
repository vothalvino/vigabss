-- Rollback 026 — drops nas.device_id. The devices created for NAS routers and
-- their links stay; they are no longer tied to their NAS, so the map shows
-- the NAS and its device as two markers.

DROP PROCEDURE IF EXISTS r026_nas_device;
DELIMITER $$
CREATE PROCEDURE r026_nas_device()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND CONSTRAINT_NAME = 'fk_nas_device'
  ) THEN
    ALTER TABLE nas DROP FOREIGN KEY fk_nas_device;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND INDEX_NAME = 'uq_nas_device'
  ) THEN
    ALTER TABLE nas DROP KEY uq_nas_device;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'device_id'
  ) THEN
    ALTER TABLE nas DROP COLUMN device_id;
  END IF;
END $$
DELIMITER ;
CALL r026_nas_device();
DROP PROCEDURE IF EXISTS r026_nas_device;
