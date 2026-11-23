-- Rollback 022 — drops olt_ports.has_eotdr. Which ports were marked as having
-- an eOTDR transceiver is lost.

DROP PROCEDURE IF EXISTS r022_olt_port_eotdr;
DELIMITER $$
CREATE PROCEDURE r022_olt_port_eotdr()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olt_ports' AND COLUMN_NAME = 'has_eotdr'
  ) THEN
    ALTER TABLE olt_ports DROP COLUMN has_eotdr;
  END IF;
END $$
DELIMITER ;
CALL r022_olt_port_eotdr();
DROP PROCEDURE IF EXISTS r022_olt_port_eotdr;
