-- =============================================================================
-- Migration 490 — tenant-owned SKUs, IP pools and device serials are unique
--                 per organization (DB-18)
-- =============================================================================
-- inventory_items.sku, ip_pools (network, mask, version) and
-- devices.serial_number were unique across the whole install although each
-- table belongs to an organization. Every application check is scoped to the
-- caller's organization, so a second tenant creating the same SKU, the same
-- private pool or the same serial passed the check, then hit the global key:
-- a 409 that also told it the value exists in another tenant. The keys become
-- (organization_id, …, active_flag), as migration 359 did for invoice numbers.
--
-- ip_assignments needs no change: its key is (pool_id, ip_address, live_flag)
-- and a pool belongs to one organization, so two tenants already get separate
-- pools for the same private range once ip_pools allows it.
--
-- devices keeps a plain index on serial_number for the TR-069 auto-link
-- lookup, which matches a serial before it knows the organization.
--
-- The new key is added before the old one is dropped, so uniqueness never
-- lapses. Guarded on INFORMATION_SCHEMA; safe to re-run.
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_490_org_scoped_unique_keys;
DELIMITER //
CREATE PROCEDURE migration_490_org_scoped_unique_keys()
BEGIN
  -- inventory_items: uq_inventory_items_sku -> uq_inventory_items_org_sku
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items' AND INDEX_NAME = 'uq_inventory_items_org_sku'
  ) THEN
    ALTER TABLE inventory_items ADD UNIQUE KEY uq_inventory_items_org_sku (organization_id, sku, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items' AND INDEX_NAME = 'uq_inventory_items_sku'
  ) THEN
    ALTER TABLE inventory_items DROP INDEX uq_inventory_items_sku;
  END IF;

  -- ip_pools: uq_ip_pools_network_mask_ver -> uq_ip_pools_org_network_mask_ver
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND INDEX_NAME = 'uq_ip_pools_org_network_mask_ver'
  ) THEN
    ALTER TABLE ip_pools ADD UNIQUE KEY uq_ip_pools_org_network_mask_ver (organization_id, network, subnet_mask, ip_version, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND INDEX_NAME = 'uq_ip_pools_network_mask_ver'
  ) THEN
    ALTER TABLE ip_pools DROP INDEX uq_ip_pools_network_mask_ver;
  END IF;

  -- devices: uq_devices_serial_number -> uq_devices_org_serial_number
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uq_devices_org_serial_number'
  ) THEN
    ALTER TABLE devices ADD UNIQUE KEY uq_devices_org_serial_number (organization_id, serial_number, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uq_devices_serial_number'
  ) THEN
    ALTER TABLE devices DROP INDEX uq_devices_serial_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_serial_number'
  ) THEN
    ALTER TABLE devices ADD KEY idx_devices_serial_number (serial_number);
  END IF;
END //
DELIMITER ;

CALL migration_490_org_scoped_unique_keys();
DROP PROCEDURE IF EXISTS migration_490_org_scoped_unique_keys;
