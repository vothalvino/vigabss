-- =============================================================================
-- Migration 006 — sealing a cash bag takes its cash off the reseller's ledger
-- =============================================================================
-- Until now (migration 005) sealing a bag booked nothing: the declared amount
-- D stayed in the reseller's balance, was shown apart as in_bags, and only a
-- deposit of -D on receipt took it off. The ISP now takes D off at the moment
-- the reseller seals the bag (services/cashBagService.js):
--
--   * reseller_ledger_entries.entry_type gains 'bag_sealed' (amount -D,
--     cash_bag_id = the bag, created_by = the reseller user that sealed it).
--     Only the seal writes it; staff cannot post one by hand.
--   * Receiving the bag posts only the difference with the count, D - C, as
--     an adjustment (a short bag raises the debt, an over bag lowers it).
--   * A lost bag posts nothing: the cash left the reseller's ledger when it
--     was sealed, so the ISP absorbs the loss.
--   * cash_on_hand is now the balance itself; in_bags (bags ready_for_pickup
--     or in_transit) is shown for information and subtracted nowhere.
--
-- Backfill: every bag already sealed under migration 005 and still
-- ready_for_pickup or in_transit gets its -D 'bag_sealed' line, dated when it
-- was sealed and recorded by the user that sealed it (or, when that user is
-- not in this database, the one that registered the bag), so its reseller's
-- balance moves exactly as if the seal had posted it. Bags already received
-- (a deposit of -D was posted) or lost (nothing was posted; the reseller
-- still owes D under the old rule) keep their history and get nothing.
--
-- Runs on the primary database and, with MIGRATE_ISOLATED_TENANTS, on every
-- isolated organization database (src/scripts/migrate.js), which hold their
-- own cash_bags and reseller_ledger_entries. Safe to re-run: the ENUM change
-- is guarded and the backfill inserts only for bags with no 'bag_sealed' line.
-- =============================================================================

DROP PROCEDURE IF EXISTS m006_bag_sealed_entry_type;
DELIMITER $$
CREATE PROCEDURE m006_bag_sealed_entry_type()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'entry_type'
       AND COLUMN_TYPE NOT LIKE '%''bag_sealed''%'
  ) THEN
    ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type
      ENUM('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed') NOT NULL
      COMMENT 'collection +, collection_void -, deposit -, adjustment +/-, bag_sealed - (migration 006)';
  END IF;
END $$
DELIMITER ;
CALL m006_bag_sealed_entry_type();
DROP PROCEDURE IF EXISTS m006_bag_sealed_entry_type;

INSERT INTO reseller_ledger_entries
  (organization_id, reseller_id, entry_type, amount, currency, payment_id, cash_session_id, note, created_by, created_at, cash_bag_id)
SELECT b.organization_id, b.reseller_id, 'bag_sealed', -b.declared_amount, b.currency, NULL, NULL,
       CONCAT('Bolsa ', b.serial, ' sellada'), COALESCE(us.id, uc.id), COALESCE(b.sealed_at, b.updated_at), b.id
  FROM cash_bags b
  LEFT JOIN users us ON us.id = b.sealed_by
  LEFT JOIN users uc ON uc.id = b.created_by
 WHERE NOT EXISTS (
         SELECT 1 FROM reseller_ledger_entries e
          WHERE e.cash_bag_id = b.id AND e.entry_type = 'bag_sealed'
       )
   AND b.status IN ('ready_for_pickup', 'in_transit')
   AND b.deleted_at IS NULL
   AND b.reseller_id IS NOT NULL
   AND b.declared_amount IS NOT NULL
   AND b.declared_amount > 0
   AND COALESCE(us.id, uc.id) IS NOT NULL;
