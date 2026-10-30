-- =============================================================================
-- Migration 469 — CFDI documents: freeze links and fiscal fields once filed
-- =============================================================================
-- BIL-10: PUT /cfdi-documents/:id could re-point a stamped CFDI's invoice_id /
-- client_id / payment_id / credit_note_id (and its folio and receptor régimen /
-- CP), because migration 148's trigger protected only the amounts, receptor
-- RFC/name, UUID and XML, and only while sat_status = 'vigente'. Re-pointing
-- invoice_id let the original invoice be voided as if it had never been
-- stamped, and cancel_pending / cancelado rows stayed fully editable.
--
-- The route is now draft-only (src/routes/cfdiDocuments.js). This replaces the
-- trigger so the database enforces the same rule for every row SAT already
-- knows about: once sat_status is 'vigente', 'cancel_pending' or 'cancelado',
-- the source links, folio, receptor and fiscal fields can no longer change.
-- Still allowed on those rows: sat_status (the cancellation flow), the
-- cancellation_* columns, cancelled_at, stamp/PAC metadata, the file ids and
-- updated_at. Comparisons are null-safe (<=>), so NULL <-> value changes are
-- caught as well. Draft rows are not constrained.
--
-- Trigger-only change: no table DDL. database/schema.sql carries the same body.
-- =============================================================================

DELIMITER $$

DROP TRIGGER IF EXISTS trg_cfdi_documents_immutable_bu$$
CREATE TRIGGER trg_cfdi_documents_immutable_bu
BEFORE UPDATE ON cfdi_documents
FOR EACH ROW
BEGIN
    IF OLD.sat_status IN ('vigente', 'cancel_pending', 'cancelado') THEN
        IF NOT (NEW.subtotal          <=> OLD.subtotal)
        OR NOT (NEW.total_impuestos   <=> OLD.total_impuestos)
        OR NOT (NEW.total             <=> OLD.total)
        OR NOT (NEW.tipo_comprobante  <=> OLD.tipo_comprobante)
        OR NOT (NEW.uso_cfdi          <=> OLD.uso_cfdi)
        OR NOT (NEW.metodo_pago       <=> OLD.metodo_pago)
        OR NOT (NEW.forma_pago        <=> OLD.forma_pago)
        OR NOT (NEW.moneda            <=> OLD.moneda)
        OR NOT (NEW.receptor_rfc      <=> OLD.receptor_rfc)
        OR NOT (NEW.receptor_nombre   <=> OLD.receptor_nombre)
        OR NOT (NEW.receptor_regimen  <=> OLD.receptor_regimen)
        OR NOT (NEW.receptor_cp       <=> OLD.receptor_cp)
        OR NOT (NEW.uuid              <=> OLD.uuid)
        OR NOT (NEW.xml_content       <=> OLD.xml_content)
        OR NOT (NEW.signed_xml        <=> OLD.signed_xml)
        OR NOT (NEW.organization_id   <=> OLD.organization_id)
        OR NOT (NEW.client_id         <=> OLD.client_id)
        OR NOT (NEW.invoice_id        <=> OLD.invoice_id)
        OR NOT (NEW.payment_id        <=> OLD.payment_id)
        OR NOT (NEW.credit_note_id    <=> OLD.credit_note_id)
        OR NOT (NEW.serie             <=> OLD.serie)
        OR NOT (NEW.folio             <=> OLD.folio)
        THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Filed CFDI documents (vigente/cancel_pending/cancelado) cannot be modified; use the cancellation flow';
        END IF;
    END IF;
END$$

DELIMITER ;
