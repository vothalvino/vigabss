-- =============================================================================
-- Migration 030 — a draft is reviewed in the reviewer's own language
-- =============================================================================
-- The closing message to a customer is written in the customer's language.
-- The person who approves a draft reads it in their own:
--
--   notice_lang     the language the message was written in, when it is
--                   known (NULL when it followed what the customer wrote)
--   notice_reviews  the message put into each reviewer language asked for,
--                   so it is translated once per language
--
-- Safe to re-run: each column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m030_incident_notice_review;
DELIMITER $$
CREATE PROCEDURE m030_incident_notice_review()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_incident_reports' AND COLUMN_NAME = 'notice_lang'
  ) THEN
    ALTER TABLE network_incident_reports
      ADD COLUMN notice_lang VARCHAR(12) NULL DEFAULT NULL
        COMMENT 'Language notice_text was written in when known; NULL = the language the customer wrote in (migration 030)'
        AFTER notice_text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'network_incident_reports' AND COLUMN_NAME = 'notice_reviews'
  ) THEN
    ALTER TABLE network_incident_reports
      ADD COLUMN notice_reviews JSON NULL
        COMMENT 'notice_text put into each reviewer language asked for, keyed by language (migration 030)'
        AFTER notice_lang;
  END IF;
END $$
DELIMITER ;
CALL m030_incident_notice_review();
DROP PROCEDURE IF EXISTS m030_incident_notice_review;
