-- =============================================================================
-- Migration 005 — reseller app, phase 3 (cash bags and carriers)
-- =============================================================================
-- A reseller (Punto de Venta) that reaches its credit limit seals the cash it
-- holds in a numbered money bag; a carrier collects the bag and brings it to
-- the ISP, which counts and receives it. The bag's life is a state machine
-- owned by services/cashBagService.js:
--
--   in_stock -> with_carrier -> at_reseller -> ready_for_pickup -> in_transit
--   -> received, plus void (no money in it), lost (money in it) and two
--   returns (with_carrier -> in_stock, at_reseller -> with_carrier).
--
--   * cash_bags — one row per physical bag, serial unique per organization
--     (stored trimmed and uppercase). declared_amount is what the reseller
--     says it sealed; counted_amount what the ISP counted on receipt.
--     reseller_id is always a top-level reseller (cash is booked there).
--   * cash_bag_events — append-only history: every transition, its actor
--     and time, the amount declared (seal) or counted (receive).
--   * carrier_reseller_assignments — which top-level resellers a carrier
--     account may see and visit.
--   * reseller_ledger_entries.cash_bag_id — the bag behind a deposit or an
--     adjustment posted when it is received. No new entry type: a sealed bag
--     is derived from cash_bags (in_bags), not booked.
--   * resellers.address, city, latitude, longitude — where the carrier goes.
--   * The system user group 'carrier' (carrier_app.use, carrier_app.pickup and
--     its own passkeys). A carrier is fenced to /carrier-app
--     (middleware/resellerFence.js) whatever its group later holds.
--   * cash_bags.view, cash_bags.manage, cash_bags.receive, carriers.manage
--     granted to admin; reseller_app.bags granted to reseller_admin and
--     admin. admin holds every non-platform permission (seed invariant).
--
-- User ids (carrier_user_id, actor_user_id, sealed_by, ...) are primary-DB
-- users.id without a foreign key, like reseller_user_bindings.user_id: an
-- isolated organization keeps these tables in its own database.
--
-- Safe to re-run: the DDL is guarded and the seeds use INSERT IGNORE.
-- =============================================================================

DROP PROCEDURE IF EXISTS m005_reseller_location;
DELIMITER $$
CREATE PROCEDURE m005_reseller_location()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'address'
  ) THEN
    ALTER TABLE resellers ADD COLUMN address VARCHAR(255) NULL DEFAULT NULL
      COMMENT 'Street address of the point of sale, for the carrier route (migration 005)'
      AFTER contact_name;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'city'
  ) THEN
    ALTER TABLE resellers ADD COLUMN city VARCHAR(100) NULL DEFAULT NULL
      COMMENT 'City of the point of sale (migration 005)'
      AFTER address;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'latitude'
  ) THEN
    ALTER TABLE resellers ADD COLUMN latitude DECIMAL(10, 7) NULL DEFAULT NULL
      COMMENT 'Point of sale latitude, for the carrier map link (migration 005)'
      AFTER city;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'resellers' AND COLUMN_NAME = 'longitude'
  ) THEN
    ALTER TABLE resellers ADD COLUMN longitude DECIMAL(10, 7) NULL DEFAULT NULL
      COMMENT 'Point of sale longitude (migration 005)'
      AFTER latitude;
  END IF;
END $$
DELIMITER ;
CALL m005_reseller_location();
DROP PROCEDURE IF EXISTS m005_reseller_location;

CREATE TABLE IF NOT EXISTS cash_bags (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id  BIGINT UNSIGNED NOT NULL COMMENT 'Organization that owns the bag',
  serial           VARCHAR(64)     NOT NULL COMMENT 'Serial printed on the bag, trimmed and uppercase',
  status           ENUM('in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost')
                     NOT NULL DEFAULT 'in_stock' COMMENT 'State machine of services/cashBagService.js',
  reseller_id      BIGINT UNSIGNED NULL     COMMENT 'Top-level reseller holding (or that filled) the bag',
  carrier_user_id  BIGINT UNSIGNED NULL     COMMENT 'Carrier that holds, dropped off or picked up the bag (primary-DB users.id; no FK)',
  declared_amount  DECIMAL(12, 2)  NULL     COMMENT 'Cash the reseller declared when sealing',
  counted_amount   DECIMAL(12, 2)  NULL     COMMENT 'Cash the ISP counted on receipt',
  currency         CHAR(3)         NOT NULL COMMENT 'ISO 4217; the organization currency',
  sealed_at        DATETIME        NULL,
  sealed_by        BIGINT UNSIGNED NULL     COMMENT 'Reseller user that sealed it (primary-DB users.id; no FK)',
  picked_up_at     DATETIME        NULL,
  picked_up_by     BIGINT UNSIGNED NULL     COMMENT 'Carrier that picked it up (primary-DB users.id; no FK)',
  received_at      DATETIME        NULL,
  received_by      BIGINT UNSIGNED NULL     COMMENT 'Staff user that counted and received it (primary-DB users.id; no FK)',
  notes            VARCHAR(500)    NULL,
  created_by       BIGINT UNSIGNED NOT NULL COMMENT 'Staff user that registered it (primary-DB users.id; no FK)',
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at       DATETIME        DEFAULT NULL COMMENT 'Soft delete; a bag with any money history is never deleted',
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_bags_org_serial (organization_id, serial),
  KEY idx_cash_bags_org_status (organization_id, status),
  KEY idx_cash_bags_reseller_status (reseller_id, status),
  KEY idx_cash_bags_carrier_status (carrier_user_id, status),
  CONSTRAINT fk_cash_bags_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cash_bags_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Numbered money bags a reseller fills and a carrier brings to the ISP (migration 005)';

CREATE TABLE IF NOT EXISTS cash_bag_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id  BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the bag',
  bag_id           BIGINT UNSIGNED NOT NULL COMMENT 'The bag',
  from_status      ENUM('in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost')
                     NULL COMMENT 'NULL when the bag was registered',
  to_status        ENUM('in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost')
                     NOT NULL,
  actor_user_id    BIGINT UNSIGNED NOT NULL COMMENT 'User that made the change (primary-DB users.id; no FK)',
  amount           DECIMAL(12, 2)  NULL     COMMENT 'Declared on seal, counted on receive',
  reseller_id      BIGINT UNSIGNED NULL     COMMENT 'Reseller of the bag at the change',
  carrier_user_id  BIGINT UNSIGNED NULL     COMMENT 'Carrier of the bag at the change (primary-DB users.id; no FK)',
  latitude         DECIMAL(10, 7)  NULL     COMMENT 'Where the carrier was, when the app sent it',
  longitude        DECIMAL(10, 7)  NULL,
  note             VARCHAR(500)    NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cash_bag_events_bag (bag_id, id),
  KEY idx_cash_bag_events_org (organization_id, created_at),
  KEY idx_cash_bag_events_reseller (reseller_id),
  CONSTRAINT fk_cash_bag_events_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cash_bag_events_bag FOREIGN KEY (bag_id)
    REFERENCES cash_bags (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_cash_bag_events_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only history of each cash bag: every transition, who and when (migration 005)';

CREATE TABLE IF NOT EXISTS carrier_reseller_assignments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id  BIGINT UNSIGNED NOT NULL COMMENT 'Organization of the carrier and the reseller',
  carrier_user_id  BIGINT UNSIGNED NOT NULL COMMENT 'Carrier account (primary-DB users.id; no FK)',
  reseller_id      BIGINT UNSIGNED NOT NULL COMMENT 'Top-level reseller the carrier may see and visit',
  created_by       BIGINT UNSIGNED NULL     COMMENT 'Administrator that assigned it (primary-DB users.id; no FK)',
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_carrier_reseller (carrier_user_id, reseller_id),
  KEY idx_carrier_reseller_org (organization_id),
  KEY idx_carrier_reseller_reseller (reseller_id),
  CONSTRAINT fk_carrier_reseller_organization FOREIGN KEY (organization_id)
    REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_carrier_reseller_reseller FOREIGN KEY (reseller_id)
    REFERENCES resellers (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Top-level resellers a carrier account may see in the carrier app (migration 005)';

DROP PROCEDURE IF EXISTS m005_ledger_cash_bag;
DELIMITER $$
CREATE PROCEDURE m005_ledger_cash_bag()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND COLUMN_NAME = 'cash_bag_id'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD COLUMN cash_bag_id BIGINT UNSIGNED NULL DEFAULT NULL
      COMMENT 'The received cash bag behind a deposit or an adjustment (migration 005)'
      AFTER cash_session_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries' AND INDEX_NAME = 'idx_reseller_ledger_cash_bag'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD KEY idx_reseller_ledger_cash_bag (cash_bag_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reseller_ledger_entries'
       AND CONSTRAINT_NAME = 'fk_reseller_ledger_cash_bag' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE reseller_ledger_entries ADD CONSTRAINT fk_reseller_ledger_cash_bag FOREIGN KEY (cash_bag_id)
      REFERENCES cash_bags (id) ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$
DELIMITER ;
CALL m005_ledger_cash_bag();
DROP PROCEDURE IF EXISTS m005_ledger_cash_bag;

-- The carrier user group. 'readonly' is its persona (the users.role mirror);
-- its permissions are only the carrier app and its own passkeys.
INSERT IGNORE INTO roles (name, description, kind, is_system) VALUES
  ('carrier', 'Carrier — picks up reseller cash bags and drops off empty ones (carrier app only)', 'readonly', 1);

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('carrier_app.use', 'Use the carrier app: assigned resellers and the bags in hand', 'carrier_app'),
  ('carrier_app.pickup', 'Pick up sealed cash bags and drop off empty ones in the carrier app', 'carrier_app'),
  ('cash_bags.view', 'View cash bags, their history and the per-reseller differences', 'cash_bags'),
  ('cash_bags.manage', 'Register cash bags, hand them to carriers, return, void or mark them lost', 'cash_bags'),
  ('cash_bags.receive', 'Count and receive a cash bag, posting its deposit to the reseller ledger', 'cash_bags'),
  ('carriers.manage', 'Create carrier accounts and choose which resellers each may visit', 'carriers'),
  ('reseller_app.bags', 'See the reseller''s cash bags and seal one with the cash it holds', 'reseller_app');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('carrier_app.use', 'carrier_app.pickup', 'webauthn.view', 'webauthn.create', 'webauthn.delete')
 WHERE r.name = 'carrier'
   AND r.is_system = 1;

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('reseller_app.bags')
 WHERE r.name = 'reseller_admin'
   AND r.is_system = 1;

-- admin holds every non-platform permission (seed invariant); the carrier
-- app still refuses any user outside the carrier group, and the reseller app
-- any user not bound to a reseller.
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN (
    'carrier_app.use', 'carrier_app.pickup', 'cash_bags.view', 'cash_bags.manage',
    'cash_bags.receive', 'carriers.manage', 'reseller_app.bags'
  )
 WHERE r.name = 'admin'
   AND r.is_system = 1;
