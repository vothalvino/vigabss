-- =============================================================================
-- Migration 510 — archive every privacy notice that was served (REG-11)
-- =============================================================================
-- A consent stored only the notice version and its hash; the text itself was
-- rebuilt on demand from the organization's current settings, so once the
-- notice or the organization's details changed nothing could show what a
-- subscriber had accepted. privacy_notice_versions keeps each distinct text
-- the first time it is served, and subscriber_consents points at the row it
-- accepted. Rows are evidence: never updated or deleted by the application.
-- Re-runnable: the table and column are guarded.
-- =============================================================================

CREATE TABLE IF NOT EXISTS privacy_notice_versions (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id  BIGINT UNSIGNED NOT NULL,
    version          VARCHAR(20)     NOT NULL,
    content          MEDIUMTEXT      NOT NULL,
    sha256           CHAR(64)        NOT NULL COMMENT 'SHA-256 of content; what consents and signed choices record',
    source           ENUM('org','bundled') NOT NULL COMMENT 'org = organization-authored text; bundled = filled template',
    first_served_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_privacy_notice_versions_org_sha (organization_id, sha256),
    KEY idx_privacy_notice_versions_org_version (organization_id, version),
    CONSTRAINT fk_privacy_notice_versions_org
        FOREIGN KEY (organization_id) REFERENCES organizations (id)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Every privacy notice text served to subscribers, kept as consent evidence (REG-11)';

DROP PROCEDURE IF EXISTS migration_510_privacy_notice_versions;
DELIMITER //
CREATE PROCEDURE migration_510_privacy_notice_versions()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriber_consents' AND COLUMN_NAME = 'privacy_notice_version_id'
  ) THEN
    ALTER TABLE subscriber_consents
      ADD COLUMN privacy_notice_version_id BIGINT UNSIGNED NULL
        COMMENT 'The archived notice text this consent accepted (migration 510)'
        AFTER document_hash,
      ADD KEY idx_subscriber_consents_notice_version (privacy_notice_version_id),
      ADD CONSTRAINT fk_subscriber_consents_notice_version
        FOREIGN KEY (privacy_notice_version_id) REFERENCES privacy_notice_versions (id)
        ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END //
DELIMITER ;

CALL migration_510_privacy_notice_versions();
DROP PROCEDURE IF EXISTS migration_510_privacy_notice_versions;
