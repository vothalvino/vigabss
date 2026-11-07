-- Rollback 003 — removes the reseller app, phase 1.
-- Data that is lost: which reseller captured each lead (leads.reseller_id) and
-- each reseller's allowed plans. Clients converted from those leads keep their
-- reseller_id. reseller_admin gets back the reseller administration views it
-- held before. Roll back only to recover from a failed deploy, then roll
-- forward.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN (
    'resellers.view',
    'reseller_plan_prices.view',
    'reseller_commissions.view',
    'reseller_ip_pool_allocations.view',
    'reseller_bandwidth_quotas.view',
    'reseller_olt_port_assignments.view',
    'reseller_billing_entities.view'
  )
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
   );

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('reseller_app.use', 'reseller_app.signup');

DROP TABLE IF EXISTS reseller_allowed_plans;

DROP PROCEDURE IF EXISTS r003_leads_reseller_id;
DELIMITER $$
CREATE PROCEDURE r003_leads_reseller_id()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'
       AND CONSTRAINT_NAME = 'fk_leads_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE leads DROP FOREIGN KEY fk_leads_reseller;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'idx_leads_reseller_id'
  ) THEN
    ALTER TABLE leads DROP INDEX idx_leads_reseller_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE leads DROP COLUMN reseller_id;
  END IF;
END $$
DELIMITER ;
CALL r003_leads_reseller_id();
DROP PROCEDURE IF EXISTS r003_leads_reseller_id;
