-- =============================================================================
-- Migration 025 — provisioning ONUs on an OLT
-- =============================================================================
-- What VigaBSS needs to authorise an ONU and set its speed on a Huawei OLT:
--
--   olt_connections   gains the values every ONU on that OLT is provisioned
--                     with (line and service profile, VLANs, GEM port) and
--                     where VigaBSS's own traffic tables start;
--   olt_traffic_tables  the rate-limit tables VigaBSS created on an OLT, one
--                     per speed, so a speed is created once and reused;
--   olt_onus          the ONUs VigaBSS authorised: where they are, which
--                     contract they serve, their service-port and speeds;
--   olt_operations    every change sent to an OLT: the exact commands, what
--                     the OLT answered, who did it.
--
-- Safe to re-run: columns and tables are added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m025_olt_provisioning;
DELIMITER $$
CREATE PROCEDURE m025_olt_provisioning()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olt_connections' AND COLUMN_NAME = 'line_profile_id'
  ) THEN
    ALTER TABLE olt_connections
      ADD COLUMN line_profile_id INT UNSIGNED NULL COMMENT 'ont-lineprofile id given to a new ONU' AFTER legacy_algorithms,
      ADD COLUMN srv_profile_id INT UNSIGNED NULL COMMENT 'ont-srvprofile id given to a new ONU' AFTER line_profile_id,
      ADD COLUMN service_vlan SMALLINT UNSIGNED NULL COMMENT 'VLAN the subscriber traffic leaves the OLT on' AFTER srv_profile_id,
      ADD COLUMN user_vlan SMALLINT UNSIGNED NULL COMMENT 'VLAN on the ONU side; NULL = same as service_vlan' AFTER service_vlan,
      ADD COLUMN gem_port SMALLINT UNSIGNED NULL COMMENT 'GEM port of the line profile that carries the service' AFTER user_vlan,
      ADD COLUMN native_vlan_eth_port TINYINT UNSIGNED NULL COMMENT 'ONU Ethernet port to set untagged; NULL = do not set' AFTER gem_port,
      ADD COLUMN traffic_table_base SMALLINT UNSIGNED NOT NULL DEFAULT 200 COMMENT 'First traffic-table index VigaBSS may create' AFTER native_vlan_eth_port;
  END IF;
END $$
DELIMITER ;
CALL m025_olt_provisioning();
DROP PROCEDURE IF EXISTS m025_olt_provisioning;

CREATE TABLE IF NOT EXISTS olt_traffic_tables (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    olt_device_id       BIGINT UNSIGNED NOT NULL,
    table_index         SMALLINT UNSIGNED NOT NULL COMMENT 'traffic table ip index on the OLT',
    kbps                INT UNSIGNED    NOT NULL COMMENT 'Rate limit of the table',
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_olt_traffic_tables_index (olt_device_id, table_index),
    UNIQUE KEY uq_olt_traffic_tables_speed (olt_device_id, kbps),
    KEY idx_olt_traffic_tables_org (organization_id),
    CONSTRAINT fk_olt_traffic_tables_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_traffic_tables_device FOREIGN KEY (olt_device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Rate-limit tables VigaBSS created on an OLT (migration 025)';

CREATE TABLE IF NOT EXISTS olt_onus (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    olt_device_id       BIGINT UNSIGNED NOT NULL,
    port                VARCHAR(12)     NOT NULL COMMENT 'PON port as frame/slot/port',
    ont_id              SMALLINT UNSIGNED NOT NULL,
    serial_number       VARCHAR(20)     NOT NULL,
    contract_id         BIGINT UNSIGNED NULL COMMENT 'The contract this ONU serves',
    description         VARCHAR(64)     NOT NULL,
    service_port_index  INT UNSIGNED    NULL COMMENT 'service-port carrying the subscriber traffic',
    up_kbps             INT UNSIGNED    NOT NULL,
    down_kbps           INT UNSIGNED    NOT NULL,
    active              TINYINT(1)      NOT NULL DEFAULT 1 COMMENT '0 = switched off on the OLT (ont deactivate)',
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_olt_onus_position (olt_device_id, port, ont_id),
    KEY idx_olt_onus_org (organization_id),
    KEY idx_olt_onus_contract (contract_id),
    CONSTRAINT fk_olt_onus_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_onus_device FOREIGN KEY (olt_device_id) REFERENCES devices (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_onus_contract FOREIGN KEY (contract_id) REFERENCES contracts (id) ON DELETE SET NULL,
    CONSTRAINT fk_olt_onus_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ONUs VigaBSS authorised on an OLT (migration 025)';

CREATE TABLE IF NOT EXISTS olt_operations (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    olt_device_id       BIGINT UNSIGNED NOT NULL,
    kind                ENUM('authorise','set_speed','remove','deactivate','activate') NOT NULL,
    port                VARCHAR(12)     NULL,
    ont_id              SMALLINT UNSIGNED NULL,
    serial_number       VARCHAR(20)     NULL,
    contract_id         BIGINT UNSIGNED NULL,
    transcript          JSON            NOT NULL COMMENT 'Each command sent and what the OLT answered',
    status              ENUM('applied','failed') NOT NULL,
    error               VARCHAR(255)    NULL,
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_olt_operations_olt (olt_device_id, id),
    KEY idx_olt_operations_org (organization_id),
    CONSTRAINT fk_olt_operations_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_operations_device FOREIGN KEY (olt_device_id) REFERENCES devices (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_operations_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Every change VigaBSS sent to an OLT, with the OLT''s answers (migration 025)';
