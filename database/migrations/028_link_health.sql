-- =============================================================================
-- Migration 028 — the port and capacity of each line of the network tree
-- =============================================================================
-- A line of the tree joins a piece of equipment to the one that feeds it.
-- To judge that line (good, degraded, off) from polled measurements, VigaBSS
-- needs to know which of the equipment's ports faces its parent, and how much
-- the line can carry:
--
--   devices.uplink_interface      the polled interface (ifIndex) facing the parent
--   devices.uplink_capacity_mbps  what the line to the parent can carry
--
-- Both are optional. Without them a line is still judged on what does not
-- need them (equipment down, airtime, signal).
--
-- Safe to re-run: each column is added only when missing.
-- =============================================================================

DROP PROCEDURE IF EXISTS m028_link_health;
DELIMITER $$
CREATE PROCEDURE m028_link_health()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'uplink_interface'
  ) THEN
    ALTER TABLE devices
      ADD COLUMN uplink_interface VARCHAR(64) NULL DEFAULT NULL
        COMMENT 'Polled interface (ifIndex) that faces the parent device (migration 028)'
        AFTER parent_device_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'uplink_capacity_mbps'
  ) THEN
    ALTER TABLE devices
      ADD COLUMN uplink_capacity_mbps INT UNSIGNED NULL DEFAULT NULL
        COMMENT 'What the line to the parent device can carry, in Mbps (migration 028)'
        AFTER uplink_interface;
  END IF;
END $$
DELIMITER ;
CALL m028_link_health();
DROP PROCEDURE IF EXISTS m028_link_health;
