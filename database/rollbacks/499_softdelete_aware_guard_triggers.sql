-- =============================================================================
-- Rollback 499 — restore the migration-128 and migration-146 guard triggers
--                (no soft-delete filter)
-- =============================================================================
-- Recreates trg_contracts_radius_consistency_bu and the two credit-note cap
-- triggers as migrations 128 and 146 defined them, counting soft-deleted rows.
-- Idempotent (DROP TRIGGER IF EXISTS before each CREATE).

DELIMITER $$

DROP TRIGGER IF EXISTS trg_contracts_radius_consistency_bu$$
CREATE TRIGGER trg_contracts_radius_consistency_bu
BEFORE UPDATE ON contracts
FOR EACH ROW
BEGIN
    DECLARE v_radius_count INT;
    IF NEW.status = 'active'
       AND OLD.status != 'active'
       AND NEW.connection_type IN ('pppoe', 'pppoe_dual')
    THEN
        SELECT COUNT(*) INTO v_radius_count FROM radius WHERE contract_id = NEW.id;
        IF v_radius_count = 0 THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'PPPoE/PPPoE-dual contracts require at least one RADIUS account before activation';
        END IF;
    END IF;
END$$

DROP TRIGGER IF EXISTS trg_credit_note_invoice_cap_bi$$
CREATE TRIGGER trg_credit_note_invoice_cap_bi
BEFORE INSERT ON credit_notes
FOR EACH ROW
BEGIN
    DECLARE v_invoice_total   DECIMAL(10, 2);
    DECLARE v_already_credited DECIMAL(10, 2);

    IF NEW.invoice_id IS NOT NULL AND NEW.status != 'cancelled' THEN
        SELECT total INTO v_invoice_total
        FROM   invoices
        WHERE  id = NEW.invoice_id;

        SELECT COALESCE(SUM(total), 0) INTO v_already_credited
        FROM   credit_notes
        WHERE  invoice_id = NEW.invoice_id
          AND  status     != 'cancelled';

        IF v_already_credited + NEW.total > v_invoice_total THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Credit note total would exceed the linked invoice total';
        END IF;
    END IF;
END$$

DROP TRIGGER IF EXISTS trg_credit_note_invoice_cap_bu$$
CREATE TRIGGER trg_credit_note_invoice_cap_bu
BEFORE UPDATE ON credit_notes
FOR EACH ROW
BEGIN
    DECLARE v_invoice_total   DECIMAL(10, 2);
    DECLARE v_already_credited DECIMAL(10, 2);

    IF NEW.invoice_id IS NOT NULL AND NEW.status != 'cancelled' THEN
        SELECT total INTO v_invoice_total
        FROM   invoices
        WHERE  id = NEW.invoice_id;

        SELECT COALESCE(SUM(total), 0) INTO v_already_credited
        FROM   credit_notes
        WHERE  invoice_id = NEW.invoice_id
          AND  status     != 'cancelled'
          AND  id         != OLD.id;

        IF v_already_credited + NEW.total > v_invoice_total THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Credit note total would exceed the linked invoice total';
        END IF;
    END IF;
END$$

DELIMITER ;
