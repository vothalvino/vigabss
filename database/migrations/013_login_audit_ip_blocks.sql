-- =============================================================================
-- Migration 013 — sign-in auditing and blocked IPs
-- =============================================================================
-- 1. login_ip_blocks: an IP refused at every sign-in route (staff
--    /auth/login and /auth/login/2fa, portal /portal/auth/login). The app
--    blocks an IP on its own after too many failed sign-ins in a window
--    (services/loginSecurityService.js; LOGIN_IP_BLOCK_* settings), for longer
--    each time it comes back; staff can also block or lift by hand. Blocks are
--    install-wide (an attacker does not stop at one organization's accounts),
--    so the table has no organization_id. Private, loopback and CGNAT addresses are
--    never blocked automatically.
-- 2. Permissions login_ip_blocks.view and login_ip_blocks.manage (security
--    module; admin). Every sign-in is now written to the audit log
--    (login_success, login_failed, login_mfa_failed, account_locked,
--    portal_login_*, login_ip_blocked); no schema is needed for that.
-- 3. audit_logs gains KEY idx_audit_logs_org_action (organization_id, action,
--    created_at): the audit page now lists the actions that occur in a scope
--    (GET /audit-logs/actions) and filters by action or category, and sign-in
--    entries make the table grow faster.
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS, INSERT IGNORE, a guarded index.
-- =============================================================================

CREATE TABLE IF NOT EXISTS login_ip_blocks (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ip_address       VARCHAR(45)     NOT NULL COMMENT 'The blocked address, IPv4 or IPv6, as the app sees it',
  source           ENUM('auto', 'manual') NOT NULL COMMENT 'auto: too many failed sign-ins; manual: staff',
  failures         INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Failed sign-ins counted when it was blocked',
  refused_count    INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT 'Sign-in attempts refused while blocked',
  blocked_until    DATETIME        NULL     COMMENT 'NULL = until lifted (manual only)',
  note             VARCHAR(255)    NULL,
  created_by       BIGINT UNSIGNED NULL     COMMENT 'NULL = the app (auto)',
  lifted_at        DATETIME        NULL,
  lifted_by        BIGINT UNSIGNED NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_login_ip_blocks_ip (ip_address, lifted_at, blocked_until),
  KEY idx_login_ip_blocks_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='IPs refused at sign-in (migration 013)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('login_ip_blocks.view', 'See the IPs blocked at sign-in and why', 'security'),
  ('login_ip_blocks.manage', 'Block an IP at sign-in by hand, or lift a block', 'security');

-- admin holds every non-platform permission (seed invariant). manager does
-- not: the security module stays with admin (migration 010).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('login_ip_blocks.view', 'login_ip_blocks.manage')
 WHERE r.name = 'admin'
   AND r.is_system = 1;

DROP PROCEDURE IF EXISTS m013_audit_action_index;
DELIMITER $$
CREATE PROCEDURE m013_audit_action_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND INDEX_NAME = 'idx_audit_logs_org_action'
  ) THEN
    ALTER TABLE audit_logs ADD KEY idx_audit_logs_org_action (organization_id, action, created_at);
  END IF;
END $$
DELIMITER ;
CALL m013_audit_action_index();
DROP PROCEDURE IF EXISTS m013_audit_action_index;
