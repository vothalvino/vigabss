-- Rollback 008 — removes reseller statements (reseller program, phase 5).
-- An approved or settled statement is a record staff and the reseller agreed
-- on, and a settled one names the ledger line that settled it, so the
-- rollback refuses while any exists. Drafts and discarded drafts are dropped
-- with the table. Roll back only to recover from a failed deploy, then roll
-- forward.

DROP PROCEDURE IF EXISTS r008_refuse_with_statements;
DELIMITER $$
CREATE PROCEDURE r008_refuse_with_statements()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_settlements'
  ) THEN
    IF EXISTS (SELECT 1 FROM reseller_settlements WHERE status IN ('approved', 'settled') LIMIT 1) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Rollback 008 refused: approved or settled reseller statements exist';
    END IF;
  END IF;
END $$
DELIMITER ;
CALL r008_refuse_with_statements();
DROP PROCEDURE IF EXISTS r008_refuse_with_statements;

DROP TABLE IF EXISTS reseller_settlements;

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN (
  'reseller_settlements.view', 'reseller_settlements.manage', 'reseller_settlements.approve',
  'reseller_app.statements'
);
