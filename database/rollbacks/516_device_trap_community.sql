-- =============================================================================
-- Rollback 516 — per-device SNMP trap community (NET-24)
-- =============================================================================
-- Roll back the application code with this. Traps then authenticate with the
-- polling community only. Safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_516_device_trap_community;
DELIMITER //
CREATE PROCEDURE rollback_516_device_trap_community()
BEGIN
  IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'snmp_trap_community') THEN
    ALTER TABLE devices DROP COLUMN snmp_trap_community;
  END IF;
END //
DELIMITER ;

CALL rollback_516_device_trap_community();
DROP PROCEDURE IF EXISTS rollback_516_device_trap_community;
