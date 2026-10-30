-- =============================================================================
-- Rollback 469 — restore migration 148's CFDI immutability trigger
-- =============================================================================
-- Reinstates the vigente-only trigger body from migration 148. The route-level
-- draft-only guard on PUT /cfdi-documents/:id stays in the application.
-- =============================================================================

DELIMITER $$

DROP TRIGGER IF EXISTS trg_cfdi_documents_immutable_bu$$
CREATE TRIGGER trg_cfdi_documents_immutable_bu
BEFORE UPDATE ON cfdi_documents
FOR EACH ROW
BEGIN
    IF OLD.sat_status = 'vigente' THEN
        IF NEW.subtotal           != OLD.subtotal
        OR NEW.total_impuestos    != OLD.total_impuestos
        OR NEW.total              != OLD.total
        OR NEW.tipo_comprobante   != OLD.tipo_comprobante
        OR NEW.uso_cfdi           != OLD.uso_cfdi
        OR (NEW.metodo_pago IS NULL) != (OLD.metodo_pago IS NULL)
        OR COALESCE(NEW.metodo_pago, '') != COALESCE(OLD.metodo_pago, '')
        OR (NEW.forma_pago IS NULL) != (OLD.forma_pago IS NULL)
        OR COALESCE(NEW.forma_pago, '') != COALESCE(OLD.forma_pago, '')
        OR NEW.moneda             != OLD.moneda
        OR COALESCE(NEW.receptor_rfc, '')    != COALESCE(OLD.receptor_rfc, '')
        OR COALESCE(NEW.receptor_nombre, '') != COALESCE(OLD.receptor_nombre, '')
        OR COALESCE(NEW.uuid, '')            != COALESCE(OLD.uuid, '')
        OR (NEW.xml_content IS NULL) != (OLD.xml_content IS NULL)
        OR COALESCE(NEW.xml_content, '') != COALESCE(OLD.xml_content, '')
        OR (NEW.signed_xml IS NULL) != (OLD.signed_xml IS NULL)
        OR COALESCE(NEW.signed_xml, '') != COALESCE(OLD.signed_xml, '')
        THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Stamped CFDI documents (vigente) cannot be modified; use the cancellation flow';
        END IF;
    END IF;
END$$

DELIMITER ;
