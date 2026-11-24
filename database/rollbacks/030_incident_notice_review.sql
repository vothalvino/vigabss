-- Rollback 030 — drops the reviewer-language copies of closing messages.
-- Drafts are then reviewed in the customer's language only.

DROP PROCEDURE IF EXISTS r030_incident_notice_review;
DELIMITER $$
CREATE PROCEDURE r030_incident_notice_review()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_incident_reports' AND COLUMN_NAME = 'notice_reviews'
  ) THEN
    ALTER TABLE network_incident_reports DROP COLUMN notice_reviews;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_incident_reports' AND COLUMN_NAME = 'notice_lang'
  ) THEN
    ALTER TABLE network_incident_reports DROP COLUMN notice_lang;
  END IF;
END $$
DELIMITER ;
CALL r030_incident_notice_review();
DROP PROCEDURE IF EXISTS r030_incident_notice_review;
