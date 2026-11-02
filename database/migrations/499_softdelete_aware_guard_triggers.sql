-- =============================================================================
-- Migration 499 — make the credit-note cap and PPPoE activation guards
--                 soft-delete-aware (DAL-07)
-- =============================================================================
-- The migration-146 credit-note cap triggers summed every credit note on the
-- invoice that was not cancelled, including soft-deleted ones. Deleting a note
-- from the UI is a soft delete that leaves its status alone, so the deleted note
-- kept consuming the cap and a corrected note was refused. The migration-128
-- PPPoE activation guard counted soft-deleted RADIUS accounts, so a contract
-- whose only account had been deleted could still be activated.
--
-- Recreate the three triggers so only live rows count, as migration 370 did for
-- the payment-allocation guards. A credit note that is itself being
-- soft-deleted is not checked. The activation guard counts only live RADIUS
-- accounts; it does not require status 'active', because reactivating a
-- suspended contract can run before its accounts are re-enabled.
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
        SELECT COUNT(*) INTO v_radius_count
        FROM   radius
        WHERE  contract_id = NEW.id
          AND  deleted_at IS NULL;
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

    IF NEW.invoice_id IS NOT NULL AND NEW.status != 'cancelled' AND NEW.deleted_at IS NULL THEN
        SELECT total INTO v_invoice_total
        FROM   invoices
        WHERE  id = NEW.invoice_id;

        SELECT COALESCE(SUM(total), 0) INTO v_already_credited
        FROM   credit_notes
        WHERE  invoice_id = NEW.invoice_id
          AND  status     != 'cancelled'
          AND  deleted_at IS NULL;

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

    IF NEW.invoice_id IS NOT NULL AND NEW.status != 'cancelled' AND NEW.deleted_at IS NULL THEN
        SELECT total INTO v_invoice_total
        FROM   invoices
        WHERE  id = NEW.invoice_id;

        SELECT COALESCE(SUM(total), 0) INTO v_already_credited
        FROM   credit_notes
        WHERE  invoice_id = NEW.invoice_id
          AND  status     != 'cancelled'
          AND  deleted_at IS NULL
          AND  id         != OLD.id;

        IF v_already_credited + NEW.total > v_invoice_total THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Credit note total would exceed the linked invoice total';
        END IF;
    END IF;
END$$

DELIMITER ;
