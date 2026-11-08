-- =============================================================================
-- Migration 009 — reseller program, phase 5b: "Reportar falla" and the
-- remote signing link
-- =============================================================================
-- 1. Tickets a reseller opens from the reseller app ("Reportar falla") for a
--    client of its subtree land in the ISP's normal ticket queue with the new
--    source 'reseller' and tickets.reseller_id, the reseller whose user
--    reported it.
--
-- 2. document_signing_links: a single-use-per-document, expiring link the ISP
--    sends the customer (email or SMS to the contact on file, or a copy for
--    staff to hand over) so the customer reads and signs the pending legal
--    documents of a new installation on its own device. Only the SHA-256 of
--    the token is stored. The link is the ISP's: a reseller may ask the ISP
--    to send it for its own lead, but never sees it. The existing signing
--    rules still hold (services/legalDocumentService.sign): the installation
--    authorization can be signed as soon as the order is in process, the
--    activation contract only while the installation visit is in progress.
--    signed_documents.signing_link_id records which link a remote signature
--    came through (captured_by stays NULL: self-service capture).
--
-- Permission reseller_app.tickets (reseller_admin, admin). Sending a link
-- needs signed_documents.create (staff) or reseller_app.signup (reseller).
--
-- Safe to re-run: every DDL step is guarded and the seeds INSERT IGNORE.
-- =============================================================================

DROP PROCEDURE IF EXISTS m009_reseller_tickets;
DELIMITER $$
CREATE PROCEDURE m009_reseller_tickets()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE NOT LIKE '%''reseller''%'
  ) THEN
    ALTER TABLE tickets MODIFY COLUMN source
      ENUM('manual','alert','portal','ai_escalated','automation','reseller') NOT NULL DEFAULT 'manual'
      COMMENT 'How the ticket was created (migration 297; automation added by 445; reseller by 009)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE tickets ADD COLUMN reseller_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'Reseller whose user reported it from the reseller app (source reseller, migration 009)'
      AFTER source;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND INDEX_NAME = 'idx_tickets_reseller'
  ) THEN
    ALTER TABLE tickets ADD KEY idx_tickets_reseller (reseller_id, created_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets'
       AND CONSTRAINT_NAME = 'fk_tickets_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE tickets ADD CONSTRAINT fk_tickets_reseller FOREIGN KEY (reseller_id)
      REFERENCES resellers (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m009_reseller_tickets();
DROP PROCEDURE IF EXISTS m009_reseller_tickets;

CREATE TABLE IF NOT EXISTS document_signing_links (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id       BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the service order',
  service_order_id      BIGINT UNSIGNED NOT NULL COMMENT 'The new installation whose pending documents the link opens',
  client_id             BIGINT UNSIGNED NOT NULL COMMENT 'The customer the link was sent to',
  token_sha256          CHAR(64)        NOT NULL COMMENT 'SHA-256 of the link token; the token itself is never stored',
  channel               ENUM('email', 'sms', 'copy') NOT NULL COMMENT 'How it reached the customer: the contact on file, or handed over by staff',
  destination_masked    VARCHAR(100)    NULL COMMENT 'The email or phone it was sent to, masked',
  message_outbox_id     BIGINT UNSIGNED NULL COMMENT 'The queued email or SMS (no FK: the outbox may live elsewhere)',
  requested_by          BIGINT UNSIGNED NULL COMMENT 'Staff user, or reseller user, who asked the ISP to send it',
  requested_by_reseller_id BIGINT UNSIGNED NULL COMMENT 'The reseller whose user asked for it (reseller app), else NULL',
  expires_at            TIMESTAMP       NOT NULL,
  revoked_at            TIMESTAMP       NULL DEFAULT NULL COMMENT 'Replaced by a newer link of the same order, or revoked by staff',
  completed_at          TIMESTAMP       NULL DEFAULT NULL COMMENT 'Every document of the order was signed',
  last_opened_at        TIMESTAMP       NULL DEFAULT NULL,
  created_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_signing_links_token (token_sha256),
  KEY idx_document_signing_links_org_order (organization_id, service_order_id, created_at),
  KEY idx_document_signing_links_order (service_order_id),
  KEY idx_document_signing_links_client (client_id),
  KEY idx_document_signing_links_requested_by (requested_by),
  KEY idx_document_signing_links_reseller (requested_by_reseller_id),
  CONSTRAINT fk_document_signing_links_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_document_signing_links_order FOREIGN KEY (service_order_id)
    REFERENCES service_orders (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_document_signing_links_client FOREIGN KEY (client_id)
    REFERENCES clients (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_document_signing_links_requested_by FOREIGN KEY (requested_by)
    REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_document_signing_links_reseller FOREIGN KEY (requested_by_reseller_id)
    REFERENCES resellers (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Expiring links the ISP sends a customer to sign its pending installation documents remotely (migration 009)';

DROP PROCEDURE IF EXISTS m009_signed_documents_link;
DELIMITER $$
CREATE PROCEDURE m009_signed_documents_link()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents' AND COLUMN_NAME = 'signing_link_id'
  ) THEN
    ALTER TABLE signed_documents ADD COLUMN signing_link_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'The remote signing link the customer signed through (migration 009); NULL: captured on site'
      AFTER captured_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents' AND INDEX_NAME = 'idx_signed_documents_signing_link'
  ) THEN
    ALTER TABLE signed_documents ADD KEY idx_signed_documents_signing_link (signing_link_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents'
       AND CONSTRAINT_NAME = 'fk_signed_documents_signing_link' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE signed_documents ADD CONSTRAINT fk_signed_documents_signing_link FOREIGN KEY (signing_link_id)
      REFERENCES document_signing_links (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m009_signed_documents_link();
DROP PROCEDURE IF EXISTS m009_signed_documents_link;

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('reseller_app.tickets', 'Report a fault (open a ticket) for a client of the reseller and follow its status in the reseller app', 'reseller_app');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.tickets')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

-- admin holds every non-platform permission (seed invariant).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.tickets')
 WHERE r.name = 'admin'
   AND r.is_system = 1;
