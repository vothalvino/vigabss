-- Rollback 036 — drops the client's formal-invoice choice. Automatic stamping
-- then applies to every client with a fiscal profile again.

DROP PROCEDURE IF EXISTS r036_client_wants_cfdi;
DELIMITER $$
CREATE PROCEDURE r036_client_wants_cfdi()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_mx_profiles' AND COLUMN_NAME = 'wants_cfdi'
  ) THEN
    ALTER TABLE client_mx_profiles DROP COLUMN wants_cfdi;
  END IF;
END $$
DELIMITER ;
CALL r036_client_wants_cfdi();
DROP PROCEDURE IF EXISTS r036_client_wants_cfdi;
