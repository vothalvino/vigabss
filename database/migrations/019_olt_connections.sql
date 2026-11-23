-- =============================================================================
-- Migration 019 — how VigaBSS logs in to an OLT's command line
-- =============================================================================
-- An OLT (a row in devices with type 'olt') is managed over SSH. This holds
-- what that needs, one row per OLT: address, user, the password (encrypted at
-- the app layer), which driver speaks to it, and the SSH host key seen on the
-- first connection, which every later connection must match.
--
-- Safe to re-run: the table is created only when missing.
-- =============================================================================

CREATE TABLE IF NOT EXISTS olt_connections (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    device_id           BIGINT UNSIGNED NOT NULL COMMENT 'devices.id of the OLT',
    driver              ENUM('huawei_ma5800') NOT NULL DEFAULT 'huawei_ma5800'
                            COMMENT 'Which command-line dialect: Huawei MA5800/EA5800',
    host                VARCHAR(45)     NOT NULL COMMENT 'Management IP of the OLT (literal address)',
    port                SMALLINT UNSIGNED NOT NULL DEFAULT 22,
    username            VARCHAR(64)     NOT NULL,
    password_encrypted  TEXT            NOT NULL COMMENT 'AES-256-GCM, app layer (utils/encryption)',
    legacy_algorithms   TINYINT(1)      NOT NULL DEFAULT 0
                            COMMENT '1 = also offer the old SSH ciphers and key exchange older OLT software needs',
    host_key_fingerprint VARCHAR(100)   NULL
                            COMMENT 'SHA256 fingerprint pinned on the first connection; NULL = not connected yet',
    last_checked_at     DATETIME        NULL,
    last_check_ok       TINYINT(1)      NULL,
    last_check_message  VARCHAR(255)    NULL,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_olt_connections_device (device_id),
    KEY idx_olt_connections_org (organization_id),
    CONSTRAINT fk_olt_connections_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_olt_connections_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='SSH login for an OLT command line (migration 019)';
