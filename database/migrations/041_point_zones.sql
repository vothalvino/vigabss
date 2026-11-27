-- =============================================================================
-- Migration 041 — resellers and collectors belong to a zone
-- =============================================================================
-- A point (a reseller or a collector) had a free-text city and nothing else to
-- group it by. Zones let the cash bags page total and filter by area, and
-- give carriers' routes a name:
--
--   point_zones           the organization's zones: an id and a name
--   resellers.zone_id     the zone a point is in; NULL = none
--
-- Safe to re-run: the table, the column, its index and its foreign key are
-- added only when missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS point_zones (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation',
    name            VARCHAR(100)    NOT NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      DATETIME        NULL,
    active_flag     TINYINT(1) GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) STORED
                        COMMENT 'NULL when removed, so a removed zone does not block reusing its name',

    PRIMARY KEY (id),
    UNIQUE KEY uq_point_zones_name (organization_id, name, active_flag),
    CONSTRAINT fk_point_zones_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_point_zones_created_by FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Zones that group resellers and collectors (migration 041)';

DROP PROCEDURE IF EXISTS m041_reseller_zone;
DELIMITER $$
CREATE PROCEDURE m041_reseller_zone()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'zone_id'
  ) THEN
    ALTER TABLE resellers
      ADD COLUMN zone_id BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'The zone this point is in (point_zones); NULL = none (migration 041)'
        AFTER city,
      ADD KEY idx_resellers_zone (zone_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND CONSTRAINT_NAME = 'fk_resellers_zone'
  ) THEN
    ALTER TABLE resellers
      ADD CONSTRAINT fk_resellers_zone FOREIGN KEY (zone_id)
        REFERENCES point_zones (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m041_reseller_zone();
DROP PROCEDURE IF EXISTS m041_reseller_zone;
