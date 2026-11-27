-- Rollback 039 — restores the rule that every CFDI names a Mexican client,
-- which refuses a document with no client (the General Public invoice).

DROP TRIGGER IF EXISTS trg_cfdi_documents_bi;
DROP TRIGGER IF EXISTS trg_cfdi_documents_bu;

DELIMITER $$
CREATE TRIGGER trg_cfdi_documents_bi
BEFORE INSERT ON cfdi_documents
FOR EACH ROW
BEGIN
    DECLARE v_locale VARCHAR(10);
    SELECT locale INTO v_locale FROM clients WHERE id = NEW.client_id;
    IF v_locale IS NULL OR v_locale != 'MX' THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'cfdi_documents requires the referenced client to have locale = ''MX''';
    END IF;
END$$

CREATE TRIGGER trg_cfdi_documents_bu
BEFORE UPDATE ON cfdi_documents
FOR EACH ROW
BEGIN
    DECLARE v_locale VARCHAR(10);
    IF NEW.client_id != OLD.client_id THEN
        SELECT locale INTO v_locale FROM clients WHERE id = NEW.client_id;
        IF v_locale IS NULL OR v_locale != 'MX' THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'cfdi_documents requires the referenced client to have locale = ''MX''';
        END IF;
    END IF;
END$$
DELIMITER ;
