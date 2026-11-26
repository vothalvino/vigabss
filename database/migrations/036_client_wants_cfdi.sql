-- =============================================================================
-- Migration 036 — a client chooses to receive formal invoices
-- =============================================================================
-- A Mexican client's fiscal profile is filled in for the service contract, so
-- having one does not mean the client wants a CFDI in its own name. The choice
-- is now its own answer:
--
--   client_mx_profiles.wants_cfdi   1 = stamp this client's invoices with its
--                                       RFC; 0 = its paid invoices go into the
--                                       period's General Public invoice
--
-- Automatic stamping (organization_mx_profiles.cfdi_auto_stamp) follows it.
-- Clients that already have a profile with their own RFC keep being stamped:
-- they are set to 1. Safe to re-run: the column is added, and the existing
-- clients are marked, only when the column is missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m036_client_wants_cfdi;
DELIMITER $$
CREATE PROCEDURE m036_client_wants_cfdi()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_mx_profiles' AND COLUMN_NAME = 'wants_cfdi'
  ) THEN
    ALTER TABLE client_mx_profiles
      ADD COLUMN wants_cfdi TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = the client asked for formal invoices (CFDI) in its own RFC; 0 = its paid invoices go into the General Public invoice (migration 036)'
        AFTER uso_cfdi_default;
    UPDATE client_mx_profiles SET wants_cfdi = 1 WHERE rfc <> 'XAXX010101000';
  END IF;
END $$
DELIMITER ;
CALL m036_client_wants_cfdi();
DROP PROCEDURE IF EXISTS m036_client_wants_cfdi;
