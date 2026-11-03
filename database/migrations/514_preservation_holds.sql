-- =============================================================================
-- Migration 514 — case-scoped preservation holds (REG-06)
-- =============================================================================
-- Retention kept connection, accounting and CGNAT rows past their period only
-- when an IP lookup had matched and pinned evidence. An ambiguous or
-- unavailable lookup pinned nothing, a government request's date range was
-- stored but never read, and a DSAR "legal hold" only changed a status, so
-- the nightly purge went on deleting the very rows a case needed.
--
-- A hold belongs to one government request or one DSAR, names a subject
-- (client, contract, RADIUS username and/or IP address) and a UTC range
-- (held_to NULL = open-ended), and keeps every matching connection log,
-- accounting event, daily usage row, CGNAT binding and binding event until it
-- is released. Re-runnable: CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS preservation_holds (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id      BIGINT UNSIGNED NOT NULL,
    gov_data_request_id  BIGINT UNSIGNED NULL,
    dsar_request_id      BIGINT UNSIGNED NULL,
    client_id            BIGINT UNSIGNED NULL,
    contract_id          BIGINT UNSIGNED NULL,
    username             VARCHAR(253)    NULL COMMENT 'RADIUS username',
    ip_address           VARCHAR(45)     NULL COMMENT 'Assigned, framed, public or private address',
    held_from            TIMESTAMP(3)    NOT NULL COMMENT 'UTC start of the preserved range',
    held_to              TIMESTAMP(3)    NULL     COMMENT 'UTC end of the preserved range; NULL = open-ended',
    reason               VARCHAR(500)    NOT NULL,
    created_by           BIGINT UNSIGNED NULL,
    created_at           TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    released_at          TIMESTAMP(3)    NULL,
    released_by          BIGINT UNSIGNED NULL,
    release_reason       VARCHAR(500)    NULL,
    PRIMARY KEY (id),
    KEY idx_preservation_holds_active (organization_id, released_at),
    KEY idx_preservation_holds_gov (gov_data_request_id),
    KEY idx_preservation_holds_dsar (dsar_request_id),
    -- MySQL refuses a CHECK on a column whose foreign key cascades, so the
    -- case and subject keys below use RESTRICT on update too.
    CONSTRAINT chk_preservation_holds_one_case
        CHECK ((gov_data_request_id IS NOT NULL) + (dsar_request_id IS NOT NULL) = 1),
    CONSTRAINT chk_preservation_holds_subject
        CHECK (client_id IS NOT NULL OR contract_id IS NOT NULL OR username IS NOT NULL OR ip_address IS NOT NULL),
    CONSTRAINT chk_preservation_holds_range
        CHECK (held_to IS NULL OR held_to >= held_from),
    CONSTRAINT fk_preservation_holds_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_preservation_holds_gov FOREIGN KEY (gov_data_request_id)
        REFERENCES gov_data_requests (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_preservation_holds_dsar FOREIGN KEY (dsar_request_id)
        REFERENCES dsar_requests (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_preservation_holds_client FOREIGN KEY (client_id)
        REFERENCES clients (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_preservation_holds_contract FOREIGN KEY (contract_id)
        REFERENCES contracts (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT fk_preservation_holds_created_by FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_preservation_holds_released_by FOREIGN KEY (released_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Case-scoped preservation holds that suspend retention (REG-06)';
