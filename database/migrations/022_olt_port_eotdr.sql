-- =============================================================================
-- Migration 022 — a PON port can be marked as having an eOTDR transceiver
-- =============================================================================
-- Some PON optical modules have an embedded OTDR (eOTDR) that can measure the
-- fibre from the OLT side. olt_ports.has_eotdr records which ports carry one,
-- so eOTDR measurements are only offered and read for those ports.
--
-- Safe to re-run: the column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m022_olt_port_eotdr;
DELIMITER $$
CREATE PROCEDURE m022_olt_port_eotdr()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olt_ports' AND COLUMN_NAME = 'has_eotdr'
  ) THEN
    ALTER TABLE olt_ports
      ADD COLUMN has_eotdr TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = the transceiver on this port has an embedded OTDR (eOTDR) (migration 022)'
        AFTER max_onus;
  END IF;
END $$
DELIMITER ;
CALL m022_olt_port_eotdr();
DROP PROCEDURE IF EXISTS m022_olt_port_eotdr;
