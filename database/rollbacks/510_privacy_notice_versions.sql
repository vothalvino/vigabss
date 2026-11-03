-- =============================================================================
-- Rollback 510 — archive every privacy notice that was served (REG-11)
-- =============================================================================
-- Roll back the application code with this. Dropping the table discards the
-- archived notice texts. Safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_510_privacy_notice_versions;
DELIMITER //
CREATE PROCEDURE rollback_510_privacy_notice_versions()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriber_consents'
       AND CONSTRAINT_NAME = 'fk_subscriber_consents_notice_version'
  ) THEN
    ALTER TABLE subscriber_consents DROP FOREIGN KEY fk_subscriber_consents_notice_version;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriber_consents' AND COLUMN_NAME = 'privacy_notice_version_id'
  ) THEN
    ALTER TABLE subscriber_consents
      DROP KEY idx_subscriber_consents_notice_version,
      DROP COLUMN privacy_notice_version_id;
  END IF;
END //
DELIMITER ;

CALL rollback_510_privacy_notice_versions();
DROP PROCEDURE IF EXISTS rollback_510_privacy_notice_versions;

DROP TABLE IF EXISTS privacy_notice_versions;
