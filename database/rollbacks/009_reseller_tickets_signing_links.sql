-- Rollback 009 — removes "Reportar falla" tickets' source and the remote
-- signing links (reseller program, phase 5b). A ticket a reseller reported
-- would lose its source value, and a document signed through a link would
-- lose the record of the link it was signed through, so the rollback refuses
-- while either exists. Roll back only to recover from a failed deploy, then
-- roll forward.

DROP PROCEDURE IF EXISTS r009_refuse;
DELIMITER $$
CREATE PROCEDURE r009_refuse()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%''reseller''%'
  ) THEN
    IF EXISTS (SELECT 1 FROM tickets WHERE source = 'reseller' LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 009 refused: tickets reported from the reseller app exist';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents' AND COLUMN_NAME = 'signing_link_id'
  ) THEN
    IF EXISTS (SELECT 1 FROM signed_documents WHERE signing_link_id IS NOT NULL LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 009 refused: documents were signed through a remote signing link';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r009_refuse();
DROP PROCEDURE IF EXISTS r009_refuse;

DROP PROCEDURE IF EXISTS r009_schema;
DELIMITER $$
CREATE PROCEDURE r009_schema()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents'
       AND CONSTRAINT_NAME = 'fk_signed_documents_signing_link' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE signed_documents DROP FOREIGN KEY fk_signed_documents_signing_link;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents' AND INDEX_NAME = 'idx_signed_documents_signing_link'
  ) THEN
    ALTER TABLE signed_documents DROP KEY idx_signed_documents_signing_link;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents' AND COLUMN_NAME = 'signing_link_id'
  ) THEN
    ALTER TABLE signed_documents DROP COLUMN signing_link_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets'
       AND CONSTRAINT_NAME = 'fk_tickets_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE tickets DROP FOREIGN KEY fk_tickets_reseller;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND INDEX_NAME = 'idx_tickets_reseller'
  ) THEN
    ALTER TABLE tickets DROP KEY idx_tickets_reseller;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE tickets DROP COLUMN reseller_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND COLUMN_NAME = 'source'
       AND COLUMN_TYPE LIKE '%''reseller''%'
  ) THEN
    ALTER TABLE tickets MODIFY COLUMN source
      ENUM('manual','alert','portal','ai_escalated','automation') NOT NULL DEFAULT 'manual'
      COMMENT 'How the ticket was created (migration 297; automation added by 445)';
  END IF;
END $$
DELIMITER ;
CALL r009_schema();
DROP PROCEDURE IF EXISTS r009_schema;

DROP TABLE IF EXISTS document_signing_links;

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('reseller_app.tickets');
