-- =============================================================================
-- Migration 512 — undeliverable client addresses from provider reports (ASY-33)
-- =============================================================================
-- Providers report hard bounces (a dead email address, an unknown number) and
-- complaints, and nothing listened: VigaBSS kept sending to dead addresses,
-- which hurts the sender's reputation until the provider throttles it. A row
-- here marks one client's address on one channel undeliverable for the
-- contact epoch it was reported against; the client communication check
-- refuses it, and changing the address (a new epoch) lifts it. A complaint
-- withdraws marketing consent; an SMS STOP is a do-not-contact opt-out.
-- Re-runnable: CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS client_contact_suppressions (
    id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id      BIGINT UNSIGNED NOT NULL,
    client_id            BIGINT UNSIGNED NOT NULL,
    channel              ENUM('email','sms','whatsapp') NOT NULL,
    contact_epoch        BIGINT UNSIGNED NOT NULL COMMENT 'Client contact epoch of the reported address; a changed address no longer matches',
    destination          VARCHAR(320)    NOT NULL COMMENT 'The address or number the provider reported',
    reason               ENUM('bounce','complaint','unsubscribe') NOT NULL,
    provider_message_id  VARCHAR(255)    NULL,
    created_at           TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_client_contact_suppressions (client_id, channel, contact_epoch, reason),
    KEY idx_client_contact_suppressions_org (organization_id, created_at),
    CONSTRAINT fk_client_contact_suppressions_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_client_contact_suppressions_client FOREIGN KEY (client_id)
        REFERENCES clients (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Client addresses a provider reported undeliverable or complained about (ASY-33)';
