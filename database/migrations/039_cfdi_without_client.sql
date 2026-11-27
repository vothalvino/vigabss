-- =============================================================================
-- Migration 039 — a CFDI without a client can be stored
-- =============================================================================
-- cfdi_documents had a rule that the document's client must be Mexican
-- (clients.locale = 'MX'). The General Public invoice (factura global) is
-- addressed to no client: its client_id is NULL. The rule read that as "not
-- Mexican" and refused it, so a General Public invoice could never be saved
-- or stamped.
--
-- The rule now is: a document with a client needs that client to be Mexican;
-- a document with no client needs its organization to be Mexican.
--
-- Safe to re-run: both triggers are dropped and created again.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_cfdi_documents_bi;
DROP TRIGGER IF EXISTS trg_cfdi_documents_bu;

DELIMITER $$
CREATE TRIGGER trg_cfdi_documents_bi
BEFORE INSERT ON cfdi_documents
FOR EACH ROW
BEGIN
    DECLARE v_locale VARCHAR(10);
    IF NEW.client_id IS NULL THEN
        SELECT locale INTO v_locale FROM organizations WHERE id = NEW.organization_id;
        IF v_locale IS NULL OR v_locale != 'MX' THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'cfdi_documents without a client requires the organization to have locale = ''MX''';
        END IF;
    ELSE
        SELECT locale INTO v_locale FROM clients WHERE id = NEW.client_id;
        IF v_locale IS NULL OR v_locale != 'MX' THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'cfdi_documents requires the referenced client to have locale = ''MX''';
        END IF;
    END IF;
END$$

CREATE TRIGGER trg_cfdi_documents_bu
BEFORE UPDATE ON cfdi_documents
FOR EACH ROW
BEGIN
    DECLARE v_locale VARCHAR(10);
    IF NOT (NEW.client_id <=> OLD.client_id) THEN
        IF NEW.client_id IS NULL THEN
            SELECT locale INTO v_locale FROM organizations WHERE id = NEW.organization_id;
            IF v_locale IS NULL OR v_locale != 'MX' THEN
                SIGNAL SQLSTATE '45000'
                    SET MESSAGE_TEXT = 'cfdi_documents without a client requires the organization to have locale = ''MX''';
            END IF;
        ELSE
            SELECT locale INTO v_locale FROM clients WHERE id = NEW.client_id;
            IF v_locale IS NULL OR v_locale != 'MX' THEN
                SIGNAL SQLSTATE '45000'
                    SET MESSAGE_TEXT = 'cfdi_documents requires the referenced client to have locale = ''MX''';
            END IF;
        END IF;
    END IF;
END$$
DELIMITER ;
