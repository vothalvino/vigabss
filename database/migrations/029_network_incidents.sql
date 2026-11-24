-- =============================================================================
-- Migration 029 — network incidents for technicians, with their evidence
-- =============================================================================
-- When a line or a piece of equipment of the network tree turns degraded or
-- off, an incident is opened for the technicians. Nothing here is sent to a
-- customer by the watch itself.
--
--   network_incidents          one per faulty line or equipment. It stays open
--                              when the fault clears by itself (a link that is
--                              saturated every evening is fine at night): only
--                              a technician closes it, with a comment.
--   network_incident_samples   what was measured each time it was seen bad,
--                              so the pattern over days is visible.
--   network_incident_reports   the customers who reported it, each with the
--                              connection check taken at that moment, and the
--                              message they get when it is closed.
--   connection_checks          every connection check kept as evidence, with
--                              the ticket or conversation it belongs to.
--
-- The task network_health_watch judges the tree every five minutes.
--
-- Safe to re-run: tables are created only when missing; the task row is
-- replaced.
-- =============================================================================

CREATE TABLE IF NOT EXISTS network_incidents (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    device_id           BIGINT UNSIGNED NOT NULL COMMENT 'devices.id of the equipment, or of the lower end of the line',
    part                ENUM('equipment','line') NOT NULL COMMENT 'The equipment itself, or the line to what feeds it',
    cause_code          VARCHAR(40)     NOT NULL COMMENT 'First reason when it was opened, e.g. airtime, optical_drop, offline',
    worst_state         ENUM('degraded','off') NOT NULL COMMENT 'Worst state seen while open',
    status              ENUM('open','resolved') NOT NULL DEFAULT 'open',
    first_seen_at       DATETIME        NOT NULL,
    last_seen_at        DATETIME        NOT NULL COMMENT 'Last time it was measured bad',
    last_good_at        DATETIME        NULL COMMENT 'Last time it was measured good while open',
    evidence            JSON            NULL COMMENT 'Reasons and numbers of the last bad measurement',
    affected_contracts  INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Active contracts served through it when last counted',
    reopened_count      INT UNSIGNED    NOT NULL DEFAULT 0,
    closed_at           DATETIME        NULL,
    closed_by           BIGINT UNSIGNED NULL COMMENT 'users.id of the technician who closed it',
    closing_comment     TEXT            NULL COMMENT 'The technician''s own words; never shown to a customer',
    customer_message    TEXT            NULL COMMENT 'The comment rewritten for customers',
    watch_until         DATETIME        NULL COMMENT 'After closing: the same fault before this time reopens it',
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_network_incidents_org_status (organization_id, status, last_seen_at),
    KEY idx_network_incidents_device (device_id, part, status),
    CONSTRAINT fk_network_incidents_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incidents_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incidents_closed_by FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Faulty lines and equipment of the network tree, for technicians (migration 029)';

CREATE TABLE IF NOT EXISTS network_incident_samples (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    incident_id         BIGINT UNSIGNED NOT NULL,
    sampled_at          DATETIME        NOT NULL,
    state               ENUM('degraded','off') NOT NULL,
    reasons             JSON            NULL,

    PRIMARY KEY (id),
    KEY idx_network_incident_samples_incident (incident_id, sampled_at),
    KEY idx_network_incident_samples_org (organization_id),
    CONSTRAINT fk_network_incident_samples_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incident_samples_incident FOREIGN KEY (incident_id) REFERENCES network_incidents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Each bad measurement of an incident, to see its pattern over days (migration 029)';

CREATE TABLE IF NOT EXISTS connection_checks (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    contract_id         BIGINT UNSIGNED NOT NULL,
    client_id           BIGINT UNSIGNED NOT NULL,
    source              ENUM('staff','assistant') NOT NULL COMMENT 'Who asked for the check',
    reported_via        VARCHAR(20)     NULL COMMENT 'portal, whatsapp, ... when the customer reported it',
    conversation_id     BIGINT UNSIGNED NULL,
    ticket_id           BIGINT UNSIGNED NULL,
    conclusion_side     VARCHAR(30)     NOT NULL,
    conclusion_state    VARCHAR(12)     NOT NULL,
    summary             TEXT            NULL COMMENT 'What was found, written for a technician',
    payload             JSON            NOT NULL COMMENT 'The whole path as measured at that moment',
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_connection_checks_contract (contract_id, created_at),
    KEY idx_connection_checks_ticket (ticket_id),
    KEY idx_connection_checks_org (organization_id, created_at),
    CONSTRAINT fk_connection_checks_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_connection_checks_contract FOREIGN KEY (contract_id) REFERENCES contracts (id) ON DELETE CASCADE,
    CONSTRAINT fk_connection_checks_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
    CONSTRAINT fk_connection_checks_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Connection checks kept as evidence of what was measured (migration 029)';

CREATE TABLE IF NOT EXISTS network_incident_reports (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id     BIGINT UNSIGNED NOT NULL,
    incident_id         BIGINT UNSIGNED NOT NULL,
    client_id           BIGINT UNSIGNED NOT NULL,
    contract_id         BIGINT UNSIGNED NOT NULL,
    connection_check_id BIGINT UNSIGNED NULL,
    channel             VARCHAR(20)     NULL COMMENT 'Where the customer reported it; the closing message goes back there',
    conversation_id     BIGINT UNSIGNED NULL,
    reported_at         DATETIME        NOT NULL,
    notice_status       ENUM('none','draft','sent','failed','discarded') NOT NULL DEFAULT 'none'
                            COMMENT 'The closing message to this customer: draft waits for a person to approve it',
    notice_text         TEXT            NULL,
    notice_at           DATETIME        NULL,
    notice_by           BIGINT UNSIGNED NULL COMMENT 'users.id who approved or discarded a draft',

    PRIMARY KEY (id),
    UNIQUE KEY uq_network_incident_reports_once (incident_id, contract_id),
    KEY idx_network_incident_reports_org (organization_id, notice_status),
    CONSTRAINT fk_network_incident_reports_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incident_reports_incident FOREIGN KEY (incident_id) REFERENCES network_incidents (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incident_reports_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incident_reports_contract FOREIGN KEY (contract_id) REFERENCES contracts (id) ON DELETE CASCADE,
    CONSTRAINT fk_network_incident_reports_check FOREIGN KEY (connection_check_id) REFERENCES connection_checks (id) ON DELETE SET NULL,
    CONSTRAINT fk_network_incident_reports_by FOREIGN KEY (notice_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Customers who reported a network incident, and the closing message to each (migration 029)';

DELETE FROM scheduled_tasks WHERE task_name = 'network_health_watch';
INSERT IGNORE INTO scheduled_tasks
    (organization_id, task_name, task_type, handler, description, cron_expression, priority, max_retries, timeout_seconds, is_enabled)
VALUES
    (NULL, 'network_health_watch', 'other', 'networkIncidentService.watch', 'Judges every line and piece of equipment of the network tree and opens or updates incidents for technicians. Sends nothing to customers.', '*/5 * * * *', 'normal', 1, 120, 1);
