-- =============================================================================
-- Migration 516 — per-device SNMP trap community (NET-24)
-- =============================================================================
-- The trap receiver accepted any community or SNMPv3 user and attributed a
-- trap by its UDP source address alone. A v1/v2c trap must now carry the
-- device's community: this column when the device sends traps with a
-- different one, otherwise its polling snmp_community. Stored sealed like
-- snmp_community. Re-runnable: skipped once the column exists.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_516_device_trap_community;
DELIMITER //
CREATE PROCEDURE migration_516_device_trap_community()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
       AND COLUMN_NAME = 'snmp_trap_community'
  ) THEN
    ALTER TABLE devices
      ADD COLUMN snmp_trap_community VARCHAR(512) NULL
        COMMENT 'SNMP v1/v2c trap community when it differs from snmp_community; sealed at the application layer (migration 516)'
        AFTER snmp_community;
  END IF;
END //
DELIMITER ;

CALL migration_516_device_trap_community();
DROP PROCEDURE IF EXISTS migration_516_device_trap_community;
