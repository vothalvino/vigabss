-- =============================================================================
-- Migration 023 — the last reading of each ONU on a PON port
-- =============================================================================
-- When a PON port is read from the OLT, each ONU's state, distance and signal
-- are remembered here. An ONU that has lost its signal no longer reports a
-- distance, so the distance it had while it was online is what tells how far
-- along the fibre a break is. One row per ONU position (OLT, port, ONT id).
--
-- Safe to re-run: the table is created only when missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS olt_onu_readings (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    olt_device_id       BIGINT UNSIGNED NOT NULL COMMENT 'devices.id of the OLT',
    port                VARCHAR(12)     NOT NULL COMMENT 'PON port as frame/slot/port, e.g. 0/1/0',
    ont_id              SMALLINT UNSIGNED NOT NULL COMMENT 'ONT id on that port',
    serial_number       VARCHAR(20)     NULL,
    model               VARCHAR(50)     NULL,
    description         VARCHAR(100)    NULL,
    state               ENUM('online','offline') NOT NULL,
    last_down_cause     VARCHAR(40)     NULL COMMENT 'As the OLT reports it, e.g. LOSi/LOBi or dying-gasp',
    distance_m          INT UNSIGNED    NULL COMMENT 'Distance from the OLT when last online (ranging)',
    rx_power_dbm        DECIMAL(6,2)    NULL COMMENT 'Receive power when last online',
    last_online_at      DATETIME        NULL COMMENT 'Last read in which it was online',
    read_at             DATETIME        NOT NULL COMMENT 'Last read of this port',

    PRIMARY KEY (id),
    UNIQUE KEY uq_olt_onu_readings_position (olt_device_id, port, ont_id),
    KEY idx_olt_onu_readings_org (organization_id),
    CONSTRAINT fk_olt_onu_readings_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_onu_readings_device FOREIGN KEY (olt_device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Last state, distance and signal of each ONU on a PON port (migration 023)';
