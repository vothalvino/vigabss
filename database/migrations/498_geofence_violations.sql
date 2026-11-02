-- =============================================================================
-- Migration 498 — geofence violations are recorded (NPR-09)
-- =============================================================================
-- geoFenceService.evaluateAll found violations and only logged them: nothing
-- was stored and its WebSocket push called a method wsHub does not export. A
-- violation now opens a row here (one per geofence and device), later runs
-- refresh it, and the first run that finds the device back inside clears it.
-- Opening a row is what emits the geofence.violation event.
-- =============================================================================

CREATE TABLE IF NOT EXISTS geofence_violations (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id   BIGINT UNSIGNED NOT NULL,
  geofence_id       BIGINT UNSIGNED NOT NULL,
  device_id         BIGINT UNSIGNED NOT NULL,
  device_lat        DECIMAL(10,7)   NULL COMMENT 'Position at the last evaluation that found the device outside',
  device_lng        DECIMAL(10,7)   NULL,
  first_detected_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_detected_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at        DATETIME        NULL COMMENT 'First evaluation that found the device back inside; NULL while open',
  open_flag         TINYINT(1) GENERATED ALWAYS AS (IF(cleared_at IS NULL, 1, NULL)) STORED
                      COMMENT '1 while open, NULL once cleared: at most one open violation per geofence and device',
  PRIMARY KEY (id),
  UNIQUE KEY uq_geofence_violations_open (geofence_id, device_id, open_flag),
  KEY idx_geofence_violations_org (organization_id, cleared_at),
  KEY idx_geofence_violations_device (device_id),
  CONSTRAINT fk_geofence_violations_org FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_geofence_violations_geofence FOREIGN KEY (geofence_id)
    REFERENCES map_geofences (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_geofence_violations_device FOREIGN KEY (device_id)
    REFERENCES devices (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Devices found outside a geofence, one open row per geofence and device until it clears (migration 498)';
