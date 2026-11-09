-- Rollback 013 — drops the blocked-IP list and its permissions. Blocked IPs
-- can sign in again; the sign-in audit entries already written stay (they are
-- ordinary audit_logs rows). The audit action index goes too.

DROP PROCEDURE IF EXISTS r013_audit_action_index;
DELIMITER $$
CREATE PROCEDURE r013_audit_action_index()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_logs_org_action'
  ) THEN
    ALTER TABLE audit_logs DROP INDEX idx_audit_logs_org_action;
  END IF;
END $$
DELIMITER ;
CALL r013_audit_action_index();
DROP PROCEDURE IF EXISTS r013_audit_action_index;

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('login_ip_blocks.view', 'login_ip_blocks.manage');

DROP TABLE IF EXISTS login_ip_blocks;
