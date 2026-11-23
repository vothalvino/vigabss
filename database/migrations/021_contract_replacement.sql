-- =============================================================================
-- Migration 021 — a contract can replace another (technology transition)
-- =============================================================================
-- Changing a subscriber between WISP and FTTH is done with a new contract.
-- contracts.replaces_contract_id links the new contract to the one it takes
-- over from. The new contract goes through the normal activation workflow,
-- which requires the customer's signature; when it is activated, the contract
-- it replaces is terminated.
--
-- Safe to re-run: the column, index and foreign key are added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m021_contract_replacement;
DELIMITER $$
CREATE PROCEDURE m021_contract_replacement()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'replaces_contract_id'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN replaces_contract_id BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'The contract this one takes over from; it is terminated when this one is activated (migration 021)'
        AFTER access_technology;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND INDEX_NAME = 'idx_contracts_replaces'
  ) THEN
    ALTER TABLE contracts ADD KEY idx_contracts_replaces (replaces_contract_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND CONSTRAINT_NAME = 'fk_contracts_replaces'
  ) THEN
    ALTER TABLE contracts
      ADD CONSTRAINT fk_contracts_replaces FOREIGN KEY (replaces_contract_id)
        REFERENCES contracts (id) ON DELETE SET NULL;
  END IF;
END $$
DELIMITER ;
CALL m021_contract_replacement();
DROP PROCEDURE IF EXISTS m021_contract_replacement;
