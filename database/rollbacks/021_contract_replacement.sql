-- Rollback 021 — drops contracts.replaces_contract_id. Which contract replaced
-- which is lost; a pending replacement no longer terminates the contract it
-- was replacing when it is activated.

DROP PROCEDURE IF EXISTS r021_contract_replacement;
DELIMITER $$
CREATE PROCEDURE r021_contract_replacement()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND CONSTRAINT_NAME = 'fk_contracts_replaces'
  ) THEN
    ALTER TABLE contracts DROP FOREIGN KEY fk_contracts_replaces;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND INDEX_NAME = 'idx_contracts_replaces'
  ) THEN
    ALTER TABLE contracts DROP KEY idx_contracts_replaces;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'replaces_contract_id'
  ) THEN
    ALTER TABLE contracts DROP COLUMN replaces_contract_id;
  END IF;
END $$
DELIMITER ;
CALL r021_contract_replacement();
DROP PROCEDURE IF EXISTS r021_contract_replacement;
