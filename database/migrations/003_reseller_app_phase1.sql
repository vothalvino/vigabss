-- =============================================================================
-- Migration 003 — reseller app, phase 1 (sign-ups by a Punto de Venta)
-- =============================================================================
-- A reseller is a commission agent: it signs up neighbours as leads, and the
-- ISP converts, signs and installs them. A staff user bound to a reseller
-- (reseller_user_bindings) uses /api/v1/reseller-app and nothing else of the
-- staff API (middleware/resellerFence.js).
--
--   * leads.reseller_id — the reseller that captured the lead; copied to the
--     client on conversion. ON DELETE SET NULL keeps the lead if the reseller
--     row is ever removed.
--   * reseller_allowed_plans — the plans a reseller may offer. No rows means
--     every active plan of the organization.
--   * reseller_app.use and reseller_app.signup, granted to reseller_admin.
--   * reseller_admin loses the reseller administration views (resellers.view
--     and the plan price, commission, IP pool, bandwidth quota, OLT port and
--     billing entity views): a reseller user works in the reseller app, not
--     in the staff reseller pages. It keeps reseller_portal.* and webauthn.*.
--
-- Safe to re-run: the DDL is guarded, the seeds use INSERT IGNORE or
-- NOT EXISTS, and deleting grants that are already gone changes nothing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m003_leads_reseller_id;
DELIMITER $$
CREATE PROCEDURE m003_leads_reseller_id()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'reseller_id'
  ) THEN
    ALTER TABLE leads ADD COLUMN reseller_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'Reseller that captured the lead in the reseller app; copied to the client on conversion (migration 003)'
      AFTER desired_plan_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND INDEX_NAME = 'idx_leads_reseller_id'
  ) THEN
    ALTER TABLE leads ADD KEY idx_leads_reseller_id (reseller_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'
       AND CONSTRAINT_NAME = 'fk_leads_reseller' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT fk_leads_reseller FOREIGN KEY (reseller_id)
      REFERENCES resellers (id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m003_leads_reseller_id();
DROP PROCEDURE IF EXISTS m003_leads_reseller_id;

CREATE TABLE IF NOT EXISTS reseller_allowed_plans (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the reseller and the plan',
  reseller_id     BIGINT UNSIGNED NOT NULL COMMENT 'Reseller allowed to offer the plan',
  plan_id         BIGINT UNSIGNED NOT NULL COMMENT 'Plan the reseller may offer',
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reseller_allowed_plans (reseller_id, plan_id),
  KEY idx_reseller_allowed_plans_org (organization_id),
  KEY idx_reseller_allowed_plans_plan (plan_id),
  CONSTRAINT fk_reseller_allowed_plans_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_allowed_plans_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_reseller_allowed_plans_plan FOREIGN KEY (plan_id)
    REFERENCES plans (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Plans a reseller may offer in the reseller app; none means every active plan (migration 003)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('reseller_app.use', 'Use the reseller app: own clients, leads and plans', 'reseller_app'),
  ('reseller_app.signup', 'Sign up new customers as leads in the reseller app', 'reseller_app');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.use', 'reseller_app.signup')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  JOIN permissions p ON p.id = rp.permission_id
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1
   AND p.name IN (
     'resellers.view',
     'reseller_plan_prices.view',
     'reseller_commissions.view',
     'reseller_ip_pool_allocations.view',
     'reseller_bandwidth_quotas.view',
     'reseller_olt_port_assignments.view',
     'reseller_billing_entities.view'
   );
