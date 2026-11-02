-- Rollback for migration 447 — legal document templates + on-site signing
--
-- DESTRUCTIVE: drops signed_documents (the signed installation authorizations,
-- contracts and comodatos) and document_templates. It fails closed while any
-- signed_documents row exists (DB-14): export the evidence and take a backup,
-- then remove those rows deliberately before rolling this back.

DROP PROCEDURE IF EXISTS rollback_447_legal_document_signing_preflight;
DELIMITER //
CREATE PROCEDURE rollback_447_legal_document_signing_preflight()
BEGIN
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signed_documents'
  ) THEN
    IF EXISTS (SELECT 1 FROM signed_documents LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 447 refused: signed_documents holds signing evidence; export it and remove it deliberately first';
    END IF;
  END IF;
END //
DELIMITER ;

CALL rollback_447_legal_document_signing_preflight();
DROP PROCEDURE IF EXISTS rollback_447_legal_document_signing_preflight;

DELETE rp FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
WHERE p.name IN (
  'document_templates.view', 'document_templates.create', 'document_templates.update', 'document_templates.delete',
  'signed_documents.view', 'signed_documents.create', 'signed_documents.sign'
);
DELETE FROM permissions WHERE name IN (
  'document_templates.view', 'document_templates.create', 'document_templates.update', 'document_templates.delete',
  'signed_documents.view', 'signed_documents.create', 'signed_documents.sign'
);
DROP TABLE IF EXISTS signed_documents;
DROP TABLE IF EXISTS document_templates;
