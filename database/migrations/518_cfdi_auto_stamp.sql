-- =============================================================================
-- Migration 518 — opt-in CFDI stamping of generated invoices (BIL-33)
-- =============================================================================
-- The only way to stamp an invoice was POST /invoices/:id/stamp, one at a
-- time, so every invoice the billing run generated waited for someone to
-- stamp it by hand. With cfdi_auto_stamp on, the scheduled invoice run stamps
-- each invoice it generates. Off by default: stamping files a fiscal document.
-- Re-runnable: skipped once the column exists.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_518_cfdi_auto_stamp;
DELIMITER //
CREATE PROCEDURE migration_518_cfdi_auto_stamp()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organization_mx_profiles'
       AND COLUMN_NAME = 'cfdi_auto_stamp'
  ) THEN
    ALTER TABLE organization_mx_profiles
      ADD COLUMN cfdi_auto_stamp TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = the scheduled invoice run stamps each invoice it generates (migration 518)'
        AFTER pac_environment;
  END IF;
END //
DELIMITER ;

CALL migration_518_cfdi_auto_stamp();
DROP PROCEDURE IF EXISTS migration_518_cfdi_auto_stamp;
