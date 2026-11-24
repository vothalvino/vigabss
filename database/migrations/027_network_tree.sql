-- =============================================================================
-- Migration 027 — the network as a tree, with one or more main NAS at the top
-- =============================================================================
-- The tree is "what feeds what": a main NAS at the top, and under it the
-- sub-NAS routers, links, OLTs, switches, battery monitors and so on. An ISP
-- with more than one network or origin marks more than one NAS as main, and
-- gets one tree per main NAS.
--
--   nas.is_main        1 = this NAS is the top of a tree
--   devices.type       gains 'battery_monitor'
--
-- A device's place in the tree is devices.parent_device_id, which already
-- exists and was unused.
--
-- Safe to re-run: the column is added only when missing, and the type list is
-- only widened when it lacks the new value.
-- =============================================================================

DROP PROCEDURE IF EXISTS m027_network_tree;
DELIMITER $$
CREATE PROCEDURE m027_network_tree()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nas' AND COLUMN_NAME = 'is_main'
  ) THEN
    ALTER TABLE nas
      ADD COLUMN is_main TINYINT(1) NOT NULL DEFAULT 0
        COMMENT '1 = top of a network tree (migration 027)'
        AFTER device_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'type'
       AND COLUMN_TYPE LIKE '%battery_monitor%'
  ) THEN
    ALTER TABLE devices
      MODIFY COLUMN type ENUM('outdoor_cpe','indoor_cpe','ptp','ptmp_ap','olt','router','switch','onu','battery_monitor','other')
        NOT NULL DEFAULT 'other'
        COMMENT 'Device type — client: outdoor_cpe, indoor_cpe; pop: ptp, ptmp_ap, olt, router, switch, onu, battery_monitor';
  END IF;
END $$
DELIMITER ;
CALL m027_network_tree();
DROP PROCEDURE IF EXISTS m027_network_tree;
