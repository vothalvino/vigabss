-- Rollback 025 — drops the provisioning tables and the provisioning columns of
-- olt_connections. What VigaBSS authorised stays configured on the OLTs; only
-- its record of it (ONUs, traffic tables, the operation log) is lost.

DROP TABLE IF EXISTS olt_operations;
DROP TABLE IF EXISTS olt_onus;
DROP TABLE IF EXISTS olt_traffic_tables;

DROP PROCEDURE IF EXISTS r025_olt_provisioning;
DELIMITER $$
CREATE PROCEDURE r025_olt_provisioning()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'olt_connections' AND COLUMN_NAME = 'line_profile_id'
  ) THEN
    ALTER TABLE olt_connections
      DROP COLUMN line_profile_id, DROP COLUMN srv_profile_id, DROP COLUMN service_vlan, DROP COLUMN user_vlan,
      DROP COLUMN gem_port, DROP COLUMN native_vlan_eth_port, DROP COLUMN traffic_table_base;
  END IF;
END $$
DELIMITER ;
CALL r025_olt_provisioning();
DROP PROCEDURE IF EXISTS r025_olt_provisioning;
