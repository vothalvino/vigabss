-- =============================================================================
-- Rollback 490: SKUs, IP pools and device serials unique across the install
-- =============================================================================
-- Restores the global keys. Fails with a duplicate-key error if two
-- organizations now hold the same SKU, pool or serial; rename one first.
-- =============================================================================

DROP PROCEDURE IF EXISTS rollback_490_org_scoped_unique_keys;
DELIMITER //
CREATE PROCEDURE rollback_490_org_scoped_unique_keys()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items' AND INDEX_NAME = 'uq_inventory_items_sku'
  ) THEN
    ALTER TABLE inventory_items ADD UNIQUE KEY uq_inventory_items_sku (sku, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items' AND INDEX_NAME = 'uq_inventory_items_org_sku'
  ) THEN
    ALTER TABLE inventory_items DROP INDEX uq_inventory_items_org_sku;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND INDEX_NAME = 'uq_ip_pools_network_mask_ver'
  ) THEN
    ALTER TABLE ip_pools ADD UNIQUE KEY uq_ip_pools_network_mask_ver (network, subnet_mask, ip_version, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_pools' AND INDEX_NAME = 'uq_ip_pools_org_network_mask_ver'
  ) THEN
    ALTER TABLE ip_pools DROP INDEX uq_ip_pools_org_network_mask_ver;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uq_devices_serial_number'
  ) THEN
    ALTER TABLE devices ADD UNIQUE KEY uq_devices_serial_number (serial_number, active_flag);
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uq_devices_org_serial_number'
  ) THEN
    ALTER TABLE devices DROP INDEX uq_devices_org_serial_number;
  END IF;
  IF EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_serial_number'
  ) THEN
    ALTER TABLE devices DROP INDEX idx_devices_serial_number;
  END IF;
END //
DELIMITER ;

CALL rollback_490_org_scoped_unique_keys();
DROP PROCEDURE IF EXISTS rollback_490_org_scoped_unique_keys;
