-- =============================================================================
-- Rollback 463: restore the legacy Mimosa profile and pre-463 rollup bodies
-- =============================================================================
-- Best effort: any device assigned to the C5c system profile (including one
-- assigned after migration 463) is moved to the legacy profile before C5c is
-- deleted, so ON DELETE SET NULL never silently disables its polling. Duplicate
-- global-system rows consolidated by the forward repair are not resurrected.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Part 1: preserve assignments, remove C5c, and retain the B/legacy profile id
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS rollback_463_mimosa_profiles;
DELIMITER $$
CREATE PROCEDURE rollback_463_mimosa_profiles()
BEGIN
    DECLARE v_b_profile_id BIGINT UNSIGNED DEFAULT NULL;

    SELECT MIN(id) INTO v_b_profile_id
    FROM snmp_profiles
    WHERE organization_id IS NULL
      AND is_system = TRUE
      AND name IN ('Mimosa B-series PTP', 'Mimosa Networks')
      AND deleted_at IS NULL;

    IF v_b_profile_id IS NOT NULL THEN
        UPDATE devices d
        JOIN snmp_profiles c ON c.id = d.snmp_profile_id
           SET d.snmp_profile_id = v_b_profile_id
         WHERE c.organization_id IS NULL
           AND c.is_system = TRUE
           AND c.name = 'Mimosa C5c PTP'
           AND c.deleted_at IS NULL;

        UPDATE discovery_results dr
        JOIN snmp_profiles c ON c.id = dr.suggested_profile_id
           SET dr.suggested_profile_id = v_b_profile_id
         WHERE c.organization_id IS NULL
           AND c.is_system = TRUE
           AND c.name = 'Mimosa C5c PTP'
           AND c.deleted_at IS NULL;

        DELETE FROM snmp_profiles
         WHERE organization_id IS NULL
           AND is_system = TRUE
           AND name = 'Mimosa C5c PTP'
           AND deleted_at IS NULL;
    END IF;
END$$
DELIMITER ;

CALL rollback_463_mimosa_profiles();
DROP PROCEDURE IF EXISTS rollback_463_mimosa_profiles;

-- ---------------------------------------------------------------------------
-- Part 2: restore the migration-280 OID set on the retained profile id
-- ---------------------------------------------------------------------------
-- Remove rows introduced only by 463. Existing ifErrors and sysUpTime rows are
-- intentionally retained because they pre-date this migration.
DELETE spo
FROM snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
WHERE p.organization_id IS NULL
  AND p.is_system = TRUE
  AND p.name = 'Mimosa B-series PTP'
  AND p.deleted_at IS NULL
  AND spo.deleted_at IS NULL
  AND spo.oid IN (
      '1.3.6.1.2.1.2.2.1.13',
      '1.3.6.1.2.1.2.2.1.19',
      '1.3.6.1.2.1.2.2.1.8',
      '1.3.6.1.4.1.43356.2.1.2.1.8.0',
      '1.3.6.1.4.1.43356.2.1.2.6.6.0',
      '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1',
      '1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1',
      '1.3.6.1.4.1.43356.2.1.2.7.1.0',
      '1.3.6.1.4.1.43356.2.1.2.7.2.0'
  );

-- Convert the two active HC rows back to their legacy 32-bit IF-MIB roots.
UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
   SET spo.oid = '1.3.6.1.2.1.2.2.1.10',
       spo.label = 'Inbound Octets',
       spo.oid_type = 'counter',
       spo.is_per_interface = TRUE,
       spo.aggregate = FALSE,
       spo.transform = NULL,
       spo.sort_order = 10
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NULL
   AND spo.oid = '1.3.6.1.2.1.31.1.1.1.6';

UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
   SET spo.oid = '1.3.6.1.2.1.2.2.1.16',
       spo.label = 'Outbound Octets',
       spo.oid_type = 'counter',
       spo.is_per_interface = TRUE,
       spo.aggregate = FALSE,
       spo.transform = NULL,
       spo.sort_order = 20
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NULL
   AND spo.oid = '1.3.6.1.2.1.31.1.1.1.10';

-- Restore only the exact legacy Mimosa enterprise rows retired by 463.
UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
   SET spo.deleted_at = NULL
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NOT NULL
   AND spo.oid IN (
       '1.3.6.1.4.1.43356.2.1.1.1.1',
       '1.3.6.1.4.1.43356.2.1.2.1.1.1',
       '1.3.6.1.4.1.43356.2.1.2.1.1.2',
       '1.3.6.1.4.1.43356.2.1.2.1.1.3',
       '1.3.6.1.4.1.43356.2.1.2.1.1.4',
       '1.3.6.1.4.1.43356.2.1.2.1.1.7',
       '1.3.6.1.4.1.43356.2.1.2.1.1.8',
       '1.3.6.1.4.1.43356.2.1.2.1.1.10',
       '1.3.6.1.4.1.43356.2.1.2.1.1.11'
   );

UPDATE snmp_profiles
   SET name = 'Mimosa Networks',
       manufacturer = 'Mimosa',
       model_pattern = 'A[2-9]|B[2-9]|C[2-9]',
       device_type = NULL,
       snmp_version = 'v2c',
       poll_interval_sec = 60,
       is_default = FALSE,
       status = 'active',
       description = 'Mimosa Networks A/B/C-series wireless backhaul and PTMP access points. Uses Mimosa enterprise MIB (OID prefix 1.3.6.1.4.1.43356) for signal, noise floor, CCQ, air utilization, and modulation rates. Supports 2.4 GHz, 5 GHz, and 60 GHz bands.'
 WHERE organization_id IS NULL
   AND is_system = TRUE
   AND name = 'Mimosa B-series PTP'
   AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Part 3: restore the procedure bodies that existed immediately before 463
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS snmp_rollup_to_1hr;
DROP PROCEDURE IF EXISTS snmp_rollup_to_1day;
DROP PROCEDURE IF EXISTS snmp_rollup_to_1month;
DELIMITER $$

-- Procedure: snmp_rollup_to_1hr
-- Purpose:   Aggregate raw 5-min samples into hourly rows using a
--            high-watermark so missed runs catch up automatically.
--            Idempotent via INSERT ... ON DUPLICATE KEY UPDATE.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE snmp_rollup_to_1hr()
proc: BEGIN
    DECLARE v_from_ts TIMESTAMP;
    DECLARE v_to_ts   TIMESTAMP;

    SELECT COALESCE(last_processed, DATE_SUB(NOW(), INTERVAL 90 DAY))
    INTO v_from_ts
    FROM snmp_rollup_state
    WHERE rollup_name = '1hr';

    SET v_to_ts = DATE_FORMAT(NOW(), '%Y-%m-%d %H:00:00');

    IF v_from_ts >= v_to_ts THEN
        LEAVE proc;
    END IF;

    INSERT INTO snmp_metrics_1hr
        (device_id, interface_id, period_start,
         avg_if_in_octets,       min_if_in_octets,       max_if_in_octets,
         avg_if_out_octets,      min_if_out_octets,      max_if_out_octets,
         avg_if_in_errors,       min_if_in_errors,       max_if_in_errors,
         avg_if_out_errors,      min_if_out_errors,      max_if_out_errors,
         avg_cpu_usage,          min_cpu_usage,           max_cpu_usage,
         avg_memory_usage,       min_memory_usage,        max_memory_usage,
         avg_signal_strength,    min_signal_strength,     max_signal_strength,
         avg_latency_ms,         min_latency_ms,          max_latency_ms,
         avg_voltage_mv,         min_voltage_mv,          max_voltage_mv,
         avg_temperature_c,      min_temperature_c,       max_temperature_c,
         avg_fan_speed_rpm,      min_fan_speed_rpm,       max_fan_speed_rpm,
         avg_if_in_discards,     min_if_in_discards,      max_if_in_discards,
         avg_if_out_discards,    min_if_out_discards,     max_if_out_discards,
         avg_sfp_tx_power_dbm,   min_sfp_tx_power_dbm,   max_sfp_tx_power_dbm,
         avg_sfp_rx_power_dbm,   min_sfp_rx_power_dbm,   max_sfp_rx_power_dbm,
         avg_sfp_temperature_c,  min_sfp_temperature_c,  max_sfp_temperature_c,
         avg_ups_battery_pct,    min_ups_battery_pct,     max_ups_battery_pct,
         avg_ups_runtime_min,    min_ups_runtime_min,     max_ups_runtime_min,
         avg_poe_power_mw,       min_poe_power_mw,        max_poe_power_mw,
         avg_humidity_pct,       min_humidity_pct,        max_humidity_pct,
         sample_count)
    SELECT
        device_id,
        COALESCE(interface_id, '')                        AS interface_id,
        DATE_FORMAT(polled_at, '%Y-%m-%d %H:00:00')       AS period_start,
        AVG(if_in_octets),       MIN(if_in_octets),       MAX(if_in_octets),
        AVG(if_out_octets),      MIN(if_out_octets),      MAX(if_out_octets),
        AVG(if_in_errors),       MIN(if_in_errors),       MAX(if_in_errors),
        AVG(if_out_errors),      MIN(if_out_errors),      MAX(if_out_errors),
        AVG(cpu_usage),          MIN(cpu_usage),           MAX(cpu_usage),
        AVG(memory_usage),       MIN(memory_usage),        MAX(memory_usage),
        AVG(signal_strength),    MIN(signal_strength),     MAX(signal_strength),
        AVG(latency_ms),         MIN(latency_ms),          MAX(latency_ms),
        AVG(voltage_mv),         MIN(voltage_mv),          MAX(voltage_mv),
        AVG(temperature_c),      MIN(temperature_c),       MAX(temperature_c),
        AVG(fan_speed_rpm),      MIN(fan_speed_rpm),       MAX(fan_speed_rpm),
        AVG(if_in_discards),     MIN(if_in_discards),      MAX(if_in_discards),
        AVG(if_out_discards),    MIN(if_out_discards),     MAX(if_out_discards),
        AVG(sfp_tx_power_dbm),   MIN(sfp_tx_power_dbm),   MAX(sfp_tx_power_dbm),
        AVG(sfp_rx_power_dbm),   MIN(sfp_rx_power_dbm),   MAX(sfp_rx_power_dbm),
        AVG(sfp_temperature_c),  MIN(sfp_temperature_c),  MAX(sfp_temperature_c),
        AVG(ups_battery_pct),    MIN(ups_battery_pct),     MAX(ups_battery_pct),
        AVG(ups_runtime_min),    MIN(ups_runtime_min),     MAX(ups_runtime_min),
        AVG(poe_power_mw),       MIN(poe_power_mw),        MAX(poe_power_mw),
        AVG(humidity_pct),       MIN(humidity_pct),        MAX(humidity_pct),
        COUNT(*)
    FROM snmp_metrics
    WHERE polled_at >  v_from_ts
      AND polled_at <  v_to_ts
    GROUP BY
        device_id,
        COALESCE(interface_id, ''),
        DATE_FORMAT(polled_at, '%Y-%m-%d %H:00:00')
    ON DUPLICATE KEY UPDATE
        avg_if_in_octets       = VALUES(avg_if_in_octets),
        min_if_in_octets       = VALUES(min_if_in_octets),
        max_if_in_octets       = VALUES(max_if_in_octets),
        avg_if_out_octets      = VALUES(avg_if_out_octets),
        min_if_out_octets      = VALUES(min_if_out_octets),
        max_if_out_octets      = VALUES(max_if_out_octets),
        avg_if_in_errors       = VALUES(avg_if_in_errors),
        min_if_in_errors       = VALUES(min_if_in_errors),
        max_if_in_errors       = VALUES(max_if_in_errors),
        avg_if_out_errors      = VALUES(avg_if_out_errors),
        min_if_out_errors      = VALUES(min_if_out_errors),
        max_if_out_errors      = VALUES(max_if_out_errors),
        avg_cpu_usage          = VALUES(avg_cpu_usage),
        min_cpu_usage          = VALUES(min_cpu_usage),
        max_cpu_usage          = VALUES(max_cpu_usage),
        avg_memory_usage       = VALUES(avg_memory_usage),
        min_memory_usage       = VALUES(min_memory_usage),
        max_memory_usage       = VALUES(max_memory_usage),
        avg_signal_strength    = VALUES(avg_signal_strength),
        min_signal_strength    = VALUES(min_signal_strength),
        max_signal_strength    = VALUES(max_signal_strength),
        avg_latency_ms         = VALUES(avg_latency_ms),
        min_latency_ms         = VALUES(min_latency_ms),
        max_latency_ms         = VALUES(max_latency_ms),
        avg_voltage_mv         = VALUES(avg_voltage_mv),
        min_voltage_mv         = VALUES(min_voltage_mv),
        max_voltage_mv         = VALUES(max_voltage_mv),
        avg_temperature_c      = VALUES(avg_temperature_c),
        min_temperature_c      = VALUES(min_temperature_c),
        max_temperature_c      = VALUES(max_temperature_c),
        avg_fan_speed_rpm      = VALUES(avg_fan_speed_rpm),
        min_fan_speed_rpm      = VALUES(min_fan_speed_rpm),
        max_fan_speed_rpm      = VALUES(max_fan_speed_rpm),
        avg_if_in_discards     = VALUES(avg_if_in_discards),
        min_if_in_discards     = VALUES(min_if_in_discards),
        max_if_in_discards     = VALUES(max_if_in_discards),
        avg_if_out_discards    = VALUES(avg_if_out_discards),
        min_if_out_discards    = VALUES(min_if_out_discards),
        max_if_out_discards    = VALUES(max_if_out_discards),
        avg_sfp_tx_power_dbm   = VALUES(avg_sfp_tx_power_dbm),
        min_sfp_tx_power_dbm   = VALUES(min_sfp_tx_power_dbm),
        max_sfp_tx_power_dbm   = VALUES(max_sfp_tx_power_dbm),
        avg_sfp_rx_power_dbm   = VALUES(avg_sfp_rx_power_dbm),
        min_sfp_rx_power_dbm   = VALUES(min_sfp_rx_power_dbm),
        max_sfp_rx_power_dbm   = VALUES(max_sfp_rx_power_dbm),
        avg_sfp_temperature_c  = VALUES(avg_sfp_temperature_c),
        min_sfp_temperature_c  = VALUES(min_sfp_temperature_c),
        max_sfp_temperature_c  = VALUES(max_sfp_temperature_c),
        avg_ups_battery_pct    = VALUES(avg_ups_battery_pct),
        min_ups_battery_pct    = VALUES(min_ups_battery_pct),
        max_ups_battery_pct    = VALUES(max_ups_battery_pct),
        avg_ups_runtime_min    = VALUES(avg_ups_runtime_min),
        min_ups_runtime_min    = VALUES(min_ups_runtime_min),
        max_ups_runtime_min    = VALUES(max_ups_runtime_min),
        avg_poe_power_mw       = VALUES(avg_poe_power_mw),
        min_poe_power_mw       = VALUES(min_poe_power_mw),
        max_poe_power_mw       = VALUES(max_poe_power_mw),
        avg_humidity_pct       = VALUES(avg_humidity_pct),
        min_humidity_pct       = VALUES(min_humidity_pct),
        max_humidity_pct       = VALUES(max_humidity_pct),
        sample_count           = VALUES(sample_count);

    UPDATE snmp_rollup_state
    SET last_processed = v_to_ts
    WHERE rollup_name  = '1hr';
END$$

-- ---------------------------------------------------------------------------
-- Procedure: snmp_rollup_to_1day
-- Purpose:   Aggregate hourly rows into daily rows using a high-watermark.
--            Idempotent via ON DUPLICATE KEY UPDATE.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE snmp_rollup_to_1day()
proc: BEGIN
    DECLARE v_from_date DATE;
    DECLARE v_to_date   DATE;

    SELECT COALESCE(DATE(last_processed), DATE_SUB(CURDATE(), INTERVAL 1 YEAR))
    INTO v_from_date
    FROM snmp_rollup_state
    WHERE rollup_name = '1day';

    SET v_to_date = CURDATE();

    IF v_from_date >= v_to_date THEN
        LEAVE proc;
    END IF;

    INSERT INTO snmp_metrics_1day
        (device_id, interface_id, period_start,
         avg_if_in_octets,       min_if_in_octets,       max_if_in_octets,
         avg_if_out_octets,      min_if_out_octets,      max_if_out_octets,
         avg_if_in_errors,       min_if_in_errors,       max_if_in_errors,
         avg_if_out_errors,      min_if_out_errors,      max_if_out_errors,
         avg_cpu_usage,          min_cpu_usage,           max_cpu_usage,
         avg_memory_usage,       min_memory_usage,        max_memory_usage,
         avg_signal_strength,    min_signal_strength,     max_signal_strength,
         avg_latency_ms,         min_latency_ms,          max_latency_ms,
         avg_voltage_mv,         min_voltage_mv,          max_voltage_mv,
         avg_temperature_c,      min_temperature_c,       max_temperature_c,
         avg_fan_speed_rpm,      min_fan_speed_rpm,       max_fan_speed_rpm,
         avg_if_in_discards,     min_if_in_discards,      max_if_in_discards,
         avg_if_out_discards,    min_if_out_discards,     max_if_out_discards,
         avg_sfp_tx_power_dbm,   min_sfp_tx_power_dbm,   max_sfp_tx_power_dbm,
         avg_sfp_rx_power_dbm,   min_sfp_rx_power_dbm,   max_sfp_rx_power_dbm,
         avg_sfp_temperature_c,  min_sfp_temperature_c,  max_sfp_temperature_c,
         avg_ups_battery_pct,    min_ups_battery_pct,     max_ups_battery_pct,
         avg_ups_runtime_min,    min_ups_runtime_min,     max_ups_runtime_min,
         avg_poe_power_mw,       min_poe_power_mw,        max_poe_power_mw,
         avg_humidity_pct,       min_humidity_pct,        max_humidity_pct,
         sample_count)
    SELECT
        device_id,
        interface_id,
        DATE(period_start)                                     AS period_start,
        AVG(avg_if_in_octets),       MIN(min_if_in_octets),       MAX(max_if_in_octets),
        AVG(avg_if_out_octets),      MIN(min_if_out_octets),      MAX(max_if_out_octets),
        AVG(avg_if_in_errors),       MIN(min_if_in_errors),       MAX(max_if_in_errors),
        AVG(avg_if_out_errors),      MIN(min_if_out_errors),      MAX(max_if_out_errors),
        AVG(avg_cpu_usage),          MIN(min_cpu_usage),           MAX(max_cpu_usage),
        AVG(avg_memory_usage),       MIN(min_memory_usage),        MAX(max_memory_usage),
        AVG(avg_signal_strength),    MIN(min_signal_strength),     MAX(max_signal_strength),
        AVG(avg_latency_ms),         MIN(min_latency_ms),          MAX(max_latency_ms),
        AVG(avg_voltage_mv),         MIN(min_voltage_mv),          MAX(max_voltage_mv),
        AVG(avg_temperature_c),      MIN(min_temperature_c),       MAX(max_temperature_c),
        AVG(avg_fan_speed_rpm),      MIN(min_fan_speed_rpm),       MAX(max_fan_speed_rpm),
        AVG(avg_if_in_discards),     MIN(min_if_in_discards),      MAX(max_if_in_discards),
        AVG(avg_if_out_discards),    MIN(min_if_out_discards),     MAX(max_if_out_discards),
        AVG(avg_sfp_tx_power_dbm),   MIN(min_sfp_tx_power_dbm),   MAX(max_sfp_tx_power_dbm),
        AVG(avg_sfp_rx_power_dbm),   MIN(min_sfp_rx_power_dbm),   MAX(max_sfp_rx_power_dbm),
        AVG(avg_sfp_temperature_c),  MIN(min_sfp_temperature_c),  MAX(max_sfp_temperature_c),
        AVG(avg_ups_battery_pct),    MIN(min_ups_battery_pct),     MAX(max_ups_battery_pct),
        AVG(avg_ups_runtime_min),    MIN(min_ups_runtime_min),     MAX(max_ups_runtime_min),
        AVG(avg_poe_power_mw),       MIN(min_poe_power_mw),        MAX(max_poe_power_mw),
        AVG(avg_humidity_pct),       MIN(min_humidity_pct),        MAX(max_humidity_pct),
        SUM(sample_count)
    FROM snmp_metrics_1hr
    WHERE period_start >= v_from_date
      AND period_start <  v_to_date
    GROUP BY device_id, interface_id, DATE(period_start)
    ON DUPLICATE KEY UPDATE
        avg_if_in_octets       = VALUES(avg_if_in_octets),
        min_if_in_octets       = VALUES(min_if_in_octets),
        max_if_in_octets       = VALUES(max_if_in_octets),
        avg_if_out_octets      = VALUES(avg_if_out_octets),
        min_if_out_octets      = VALUES(min_if_out_octets),
        max_if_out_octets      = VALUES(max_if_out_octets),
        avg_if_in_errors       = VALUES(avg_if_in_errors),
        min_if_in_errors       = VALUES(min_if_in_errors),
        max_if_in_errors       = VALUES(max_if_in_errors),
        avg_if_out_errors      = VALUES(avg_if_out_errors),
        min_if_out_errors      = VALUES(min_if_out_errors),
        max_if_out_errors      = VALUES(max_if_out_errors),
        avg_cpu_usage          = VALUES(avg_cpu_usage),
        min_cpu_usage          = VALUES(min_cpu_usage),
        max_cpu_usage          = VALUES(max_cpu_usage),
        avg_memory_usage       = VALUES(avg_memory_usage),
        min_memory_usage       = VALUES(min_memory_usage),
        max_memory_usage       = VALUES(max_memory_usage),
        avg_signal_strength    = VALUES(avg_signal_strength),
        min_signal_strength    = VALUES(min_signal_strength),
        max_signal_strength    = VALUES(max_signal_strength),
        avg_latency_ms         = VALUES(avg_latency_ms),
        min_latency_ms         = VALUES(min_latency_ms),
        max_latency_ms         = VALUES(max_latency_ms),
        avg_voltage_mv         = VALUES(avg_voltage_mv),
        min_voltage_mv         = VALUES(min_voltage_mv),
        max_voltage_mv         = VALUES(max_voltage_mv),
        avg_temperature_c      = VALUES(avg_temperature_c),
        min_temperature_c      = VALUES(min_temperature_c),
        max_temperature_c      = VALUES(max_temperature_c),
        avg_fan_speed_rpm      = VALUES(avg_fan_speed_rpm),
        min_fan_speed_rpm      = VALUES(min_fan_speed_rpm),
        max_fan_speed_rpm      = VALUES(max_fan_speed_rpm),
        avg_if_in_discards     = VALUES(avg_if_in_discards),
        min_if_in_discards     = VALUES(min_if_in_discards),
        max_if_in_discards     = VALUES(max_if_in_discards),
        avg_if_out_discards    = VALUES(avg_if_out_discards),
        min_if_out_discards    = VALUES(min_if_out_discards),
        max_if_out_discards    = VALUES(max_if_out_discards),
        avg_sfp_tx_power_dbm   = VALUES(avg_sfp_tx_power_dbm),
        min_sfp_tx_power_dbm   = VALUES(min_sfp_tx_power_dbm),
        max_sfp_tx_power_dbm   = VALUES(max_sfp_tx_power_dbm),
        avg_sfp_rx_power_dbm   = VALUES(avg_sfp_rx_power_dbm),
        min_sfp_rx_power_dbm   = VALUES(min_sfp_rx_power_dbm),
        max_sfp_rx_power_dbm   = VALUES(max_sfp_rx_power_dbm),
        avg_sfp_temperature_c  = VALUES(avg_sfp_temperature_c),
        min_sfp_temperature_c  = VALUES(min_sfp_temperature_c),
        max_sfp_temperature_c  = VALUES(max_sfp_temperature_c),
        avg_ups_battery_pct    = VALUES(avg_ups_battery_pct),
        min_ups_battery_pct    = VALUES(min_ups_battery_pct),
        max_ups_battery_pct    = VALUES(max_ups_battery_pct),
        avg_ups_runtime_min    = VALUES(avg_ups_runtime_min),
        min_ups_runtime_min    = VALUES(min_ups_runtime_min),
        max_ups_runtime_min    = VALUES(max_ups_runtime_min),
        avg_poe_power_mw       = VALUES(avg_poe_power_mw),
        min_poe_power_mw       = VALUES(min_poe_power_mw),
        max_poe_power_mw       = VALUES(max_poe_power_mw),
        avg_humidity_pct       = VALUES(avg_humidity_pct),
        min_humidity_pct       = VALUES(min_humidity_pct),
        max_humidity_pct       = VALUES(max_humidity_pct),
        sample_count           = VALUES(sample_count);

    UPDATE snmp_rollup_state
    SET last_processed = TIMESTAMP(v_to_date)
    WHERE rollup_name  = '1day';
END$$

-- ---------------------------------------------------------------------------
-- Part 4: Create snmp_rollup_to_1month()
-- ---------------------------------------------------------------------------
CREATE PROCEDURE snmp_rollup_to_1month()
proc: BEGIN
    DECLARE v_from_date DATE;
    DECLARE v_to_date   DATE;

    -- High-watermark: default to 3 years ago on first run
    SELECT COALESCE(DATE(last_processed), DATE_SUB(CURDATE(), INTERVAL 3 YEAR))
    INTO v_from_date
    FROM snmp_rollup_state
    WHERE rollup_name = '1month';

    -- Process up to (but not including) the current month to avoid partial months
    SET v_to_date = DATE_FORMAT(CURDATE(), '%Y-%m-01');

    IF v_from_date >= v_to_date THEN
        LEAVE proc;
    END IF;

    INSERT INTO snmp_metrics_1month
        (device_id, interface_id, period_start,
         avg_if_in_octets,    min_if_in_octets,    max_if_in_octets,
         avg_if_out_octets,   min_if_out_octets,   max_if_out_octets,
         avg_if_in_errors,    min_if_in_errors,    max_if_in_errors,
         avg_if_out_errors,   min_if_out_errors,   max_if_out_errors,
         avg_cpu_usage,       min_cpu_usage,        max_cpu_usage,
         avg_memory_usage,    min_memory_usage,     max_memory_usage,
         avg_signal_strength, min_signal_strength,  max_signal_strength,
         avg_latency_ms,      min_latency_ms,       max_latency_ms,
         avg_voltage_mv,      min_voltage_mv,       max_voltage_mv,
         avg_temperature_c,   min_temperature_c,    max_temperature_c,
         avg_fan_speed_rpm,   min_fan_speed_rpm,    max_fan_speed_rpm,
         avg_if_in_discards,  min_if_in_discards,   max_if_in_discards,
         avg_if_out_discards, min_if_out_discards,  max_if_out_discards,
         avg_sfp_tx_power_dbm, min_sfp_tx_power_dbm, max_sfp_tx_power_dbm,
         avg_sfp_rx_power_dbm, min_sfp_rx_power_dbm, max_sfp_rx_power_dbm,
         avg_sfp_temperature_c, min_sfp_temperature_c, max_sfp_temperature_c,
         avg_ups_battery_pct, min_ups_battery_pct,  max_ups_battery_pct,
         avg_ups_runtime_min, min_ups_runtime_min,  max_ups_runtime_min,
         avg_poe_power_mw,    min_poe_power_mw,     max_poe_power_mw,
         avg_humidity_pct,    min_humidity_pct,     max_humidity_pct,
         avg_if_oper_status,  min_if_oper_status,   max_if_oper_status,
         sample_count)
    SELECT
        device_id,
        interface_id,
        DATE_FORMAT(period_start, '%Y-%m-01')       AS period_start,
        AVG(avg_if_in_octets),    MIN(min_if_in_octets),    MAX(max_if_in_octets),
        AVG(avg_if_out_octets),   MIN(min_if_out_octets),   MAX(max_if_out_octets),
        AVG(avg_if_in_errors),    MIN(min_if_in_errors),    MAX(max_if_in_errors),
        AVG(avg_if_out_errors),   MIN(min_if_out_errors),   MAX(max_if_out_errors),
        AVG(avg_cpu_usage),       MIN(min_cpu_usage),        MAX(max_cpu_usage),
        AVG(avg_memory_usage),    MIN(min_memory_usage),     MAX(max_memory_usage),
        AVG(avg_signal_strength), MIN(min_signal_strength),  MAX(max_signal_strength),
        AVG(avg_latency_ms),      MIN(min_latency_ms),       MAX(max_latency_ms),
        AVG(avg_voltage_mv),      MIN(min_voltage_mv),       MAX(max_voltage_mv),
        AVG(avg_temperature_c),   MIN(min_temperature_c),    MAX(max_temperature_c),
        AVG(avg_fan_speed_rpm),   MIN(min_fan_speed_rpm),    MAX(max_fan_speed_rpm),
        AVG(avg_if_in_discards),  MIN(min_if_in_discards),   MAX(max_if_in_discards),
        AVG(avg_if_out_discards), MIN(min_if_out_discards),  MAX(max_if_out_discards),
        AVG(avg_sfp_tx_power_dbm), MIN(min_sfp_tx_power_dbm), MAX(max_sfp_tx_power_dbm),
        AVG(avg_sfp_rx_power_dbm), MIN(min_sfp_rx_power_dbm), MAX(max_sfp_rx_power_dbm),
        AVG(avg_sfp_temperature_c), MIN(min_sfp_temperature_c), MAX(max_sfp_temperature_c),
        AVG(avg_ups_battery_pct), MIN(min_ups_battery_pct),  MAX(max_ups_battery_pct),
        AVG(avg_ups_runtime_min), MIN(min_ups_runtime_min),  MAX(max_ups_runtime_min),
        AVG(avg_poe_power_mw),    MIN(min_poe_power_mw),     MAX(max_poe_power_mw),
        AVG(avg_humidity_pct),    MIN(min_humidity_pct),     MAX(max_humidity_pct),
        AVG(avg_if_oper_status),  MIN(min_if_oper_status),   MAX(max_if_oper_status),
        SUM(sample_count)
    FROM snmp_metrics_1day
    WHERE period_start >= v_from_date
      AND period_start <  v_to_date
    GROUP BY device_id, interface_id, DATE_FORMAT(period_start, '%Y-%m-01')
    ON DUPLICATE KEY UPDATE
        avg_if_in_octets    = VALUES(avg_if_in_octets),
        min_if_in_octets    = VALUES(min_if_in_octets),
        max_if_in_octets    = VALUES(max_if_in_octets),
        avg_if_out_octets   = VALUES(avg_if_out_octets),
        min_if_out_octets   = VALUES(min_if_out_octets),
        max_if_out_octets   = VALUES(max_if_out_octets),
        avg_if_in_errors    = VALUES(avg_if_in_errors),
        min_if_in_errors    = VALUES(min_if_in_errors),
        max_if_in_errors    = VALUES(max_if_in_errors),
        avg_if_out_errors   = VALUES(avg_if_out_errors),
        min_if_out_errors   = VALUES(min_if_out_errors),
        max_if_out_errors   = VALUES(max_if_out_errors),
        avg_cpu_usage       = VALUES(avg_cpu_usage),
        min_cpu_usage       = VALUES(min_cpu_usage),
        max_cpu_usage       = VALUES(max_cpu_usage),
        avg_memory_usage    = VALUES(avg_memory_usage),
        min_memory_usage    = VALUES(min_memory_usage),
        max_memory_usage    = VALUES(max_memory_usage),
        avg_signal_strength = VALUES(avg_signal_strength),
        min_signal_strength = VALUES(min_signal_strength),
        max_signal_strength = VALUES(max_signal_strength),
        avg_latency_ms      = VALUES(avg_latency_ms),
        min_latency_ms      = VALUES(min_latency_ms),
        max_latency_ms      = VALUES(max_latency_ms),
        avg_voltage_mv      = VALUES(avg_voltage_mv),
        min_voltage_mv      = VALUES(min_voltage_mv),
        max_voltage_mv      = VALUES(max_voltage_mv),
        avg_temperature_c   = VALUES(avg_temperature_c),
        min_temperature_c   = VALUES(min_temperature_c),
        max_temperature_c   = VALUES(max_temperature_c),
        avg_fan_speed_rpm   = VALUES(avg_fan_speed_rpm),
        min_fan_speed_rpm   = VALUES(min_fan_speed_rpm),
        max_fan_speed_rpm   = VALUES(max_fan_speed_rpm),
        avg_if_in_discards  = VALUES(avg_if_in_discards),
        min_if_in_discards  = VALUES(min_if_in_discards),
        max_if_in_discards  = VALUES(max_if_in_discards),
        avg_if_out_discards = VALUES(avg_if_out_discards),
        min_if_out_discards = VALUES(min_if_out_discards),
        max_if_out_discards = VALUES(max_if_out_discards),
        avg_sfp_tx_power_dbm = VALUES(avg_sfp_tx_power_dbm),
        min_sfp_tx_power_dbm = VALUES(min_sfp_tx_power_dbm),
        max_sfp_tx_power_dbm = VALUES(max_sfp_tx_power_dbm),
        avg_sfp_rx_power_dbm = VALUES(avg_sfp_rx_power_dbm),
        min_sfp_rx_power_dbm = VALUES(min_sfp_rx_power_dbm),
        max_sfp_rx_power_dbm = VALUES(max_sfp_rx_power_dbm),
        avg_sfp_temperature_c = VALUES(avg_sfp_temperature_c),
        min_sfp_temperature_c = VALUES(min_sfp_temperature_c),
        max_sfp_temperature_c = VALUES(max_sfp_temperature_c),
        avg_ups_battery_pct = VALUES(avg_ups_battery_pct),
        min_ups_battery_pct = VALUES(min_ups_battery_pct),
        max_ups_battery_pct = VALUES(max_ups_battery_pct),
        avg_ups_runtime_min = VALUES(avg_ups_runtime_min),
        min_ups_runtime_min = VALUES(min_ups_runtime_min),
        max_ups_runtime_min = VALUES(max_ups_runtime_min),
        avg_poe_power_mw    = VALUES(avg_poe_power_mw),
        min_poe_power_mw    = VALUES(min_poe_power_mw),
        max_poe_power_mw    = VALUES(max_poe_power_mw),
        avg_humidity_pct    = VALUES(avg_humidity_pct),
        min_humidity_pct    = VALUES(min_humidity_pct),
        max_humidity_pct    = VALUES(max_humidity_pct),
        avg_if_oper_status  = VALUES(avg_if_oper_status),
        min_if_oper_status  = VALUES(min_if_oper_status),
        max_if_oper_status  = VALUES(max_if_oper_status),
        sample_count        = VALUES(sample_count);

    -- Advance the high-watermark
    UPDATE snmp_rollup_state
    SET last_processed = TIMESTAMP(v_to_date)
    WHERE rollup_name  = '1month';
END$$

DELIMITER ;

-- END OF ROLLBACK 463
