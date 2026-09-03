-- =============================================================================
-- Migration 463: Correct Mimosa PTP profiles and complete SNMP RF rollups
-- =============================================================================
-- The broad migration-280 "Mimosa Networks" profile mixed incompatible
-- firmware branches and mapped unpublished/incorrect enterprise OIDs. This
-- migration keeps that global system profile's id for existing assignments,
-- narrows it to B-series PTP, and adds a separate C5c PTP profile.
--
-- Important invariants:
--   * only global system profiles are changed; same-named tenant rows are not;
--   * the legacy profile is renamed in place on the normal path, preserving FK
--     assignments, and existing C5c PTP/backhaul assignments are moved safely;
--   * system-profile inserts use explicit NOT EXISTS guards because MySQL's
--     UNIQUE (organization_id, name, active_flag) permits duplicate NULL-org
--     rows;
--   * only known-bogus Mimosa enterprise rows are normally soft-deleted (a
--     redundant 32-bit row is also retired if a partial run already has HC);
--   * legacy 32-bit traffic rows are upgraded in place to IF-X Counter64, so
--     exactly one active OID writes each traffic metric; and
--   * all three aggregate procedures now carry if_oper_status and the seven RF
--     columns added by migrations 264/279.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Part 1: canonicalize the two global system profiles without touching tenants
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS migration_463_mimosa_profiles;
DELIMITER $$
CREATE PROCEDURE migration_463_mimosa_profiles()
BEGIN
    DECLARE v_b_profile_id BIGINT UNSIGNED DEFAULT NULL;
    DECLARE v_c_profile_id BIGINT UNSIGNED DEFAULT NULL;

    -- Prefer the legacy id so the normal upgrade path preserves every existing
    -- devices.snmp_profile_id. If a partial prior run left both names active,
    -- consolidate their assignments onto the legacy id before retiring only
    -- the duplicate global-system row(s).
    SELECT MIN(id) INTO v_b_profile_id
    FROM snmp_profiles
    WHERE organization_id IS NULL
      AND is_system = TRUE
      AND name = 'Mimosa Networks'
      AND deleted_at IS NULL;

    IF v_b_profile_id IS NULL THEN
        SELECT MIN(id) INTO v_b_profile_id
        FROM snmp_profiles
        WHERE organization_id IS NULL
          AND is_system = TRUE
          AND name = 'Mimosa B-series PTP'
          AND deleted_at IS NULL;
    END IF;

    IF v_b_profile_id IS NOT NULL THEN
        UPDATE devices d
        JOIN snmp_profiles p ON p.id = d.snmp_profile_id
           SET d.snmp_profile_id = v_b_profile_id
         WHERE p.organization_id IS NULL
           AND p.is_system = TRUE
           AND p.name IN ('Mimosa Networks', 'Mimosa B-series PTP')
           AND p.deleted_at IS NULL
           AND p.id <> v_b_profile_id;

        UPDATE discovery_results dr
        JOIN snmp_profiles p ON p.id = dr.suggested_profile_id
           SET dr.suggested_profile_id = v_b_profile_id
         WHERE p.organization_id IS NULL
           AND p.is_system = TRUE
           AND p.name IN ('Mimosa Networks', 'Mimosa B-series PTP')
           AND p.deleted_at IS NULL
           AND p.id <> v_b_profile_id;

        UPDATE snmp_profiles
           SET status = 'inactive',
               deleted_at = COALESCE(deleted_at, NOW())
         WHERE organization_id IS NULL
           AND is_system = TRUE
           AND name IN ('Mimosa Networks', 'Mimosa B-series PTP')
           AND deleted_at IS NULL
           AND id <> v_b_profile_id;

        UPDATE snmp_profiles
           SET name = 'Mimosa B-series PTP',
               manufacturer = 'Mimosa',
               model_pattern = 'B%',
               device_type = 'ptp',
               snmp_version = 'v2c',
               poll_interval_sec = 60,
               is_default = FALSE,
               is_system = TRUE,
               status = 'active',
               description = 'Mimosa B-series point-to-point backhaul radios on the 1.x firmware family. Uses the official B5 and C5 product MIB Rev 3.00 plus IF-MIB/IF-X-MIB.'
         WHERE id = v_b_profile_id
           AND organization_id IS NULL
           AND is_system = TRUE
           AND deleted_at IS NULL;
    ELSE
        INSERT INTO snmp_profiles
            (organization_id, is_system, name, manufacturer, model_pattern,
             device_type, snmp_version, poll_interval_sec, is_default,
             description, status)
        SELECT NULL, TRUE, 'Mimosa B-series PTP', 'Mimosa', 'B%', 'ptp',
               'v2c', 60, FALSE,
               'Mimosa B-series point-to-point backhaul radios on the 1.x firmware family. Uses the official B5 and C5 product MIB Rev 3.00 plus IF-MIB/IF-X-MIB.',
               'active'
        FROM DUAL
        WHERE NOT EXISTS (
            SELECT 1
            FROM snmp_profiles
            WHERE organization_id IS NULL
              AND is_system = TRUE
              AND name = 'Mimosa B-series PTP'
              AND deleted_at IS NULL
        )
        ON DUPLICATE KEY UPDATE name = VALUES(name);

        SELECT MIN(id) INTO v_b_profile_id
        FROM snmp_profiles
        WHERE organization_id IS NULL
          AND is_system = TRUE
          AND name = 'Mimosa B-series PTP'
          AND deleted_at IS NULL;
    END IF;

    INSERT INTO snmp_profiles
        (organization_id, is_system, name, manufacturer, model_pattern,
         device_type, snmp_version, poll_interval_sec, is_default,
         description, status)
    SELECT NULL, TRUE, 'Mimosa C5c PTP', 'Mimosa', '%C5c%', 'ptp',
           'v2c', 60, FALSE,
           'Mimosa C5c radios operating in point-to-point/backhaul mode on the 2.x firmware family. Uses the official B5 and C5 product MIB Rev 3.00 plus IF-MIB/IF-X-MIB.',
           'active'
    FROM DUAL
    WHERE NOT EXISTS (
        SELECT 1
        FROM snmp_profiles
        WHERE organization_id IS NULL
          AND is_system = TRUE
          AND name = 'Mimosa C5c PTP'
          AND deleted_at IS NULL
    )
    ON DUPLICATE KEY UPDATE name = VALUES(name);

    SELECT MIN(id) INTO v_c_profile_id
    FROM snmp_profiles
    WHERE organization_id IS NULL
      AND is_system = TRUE
      AND name = 'Mimosa C5c PTP'
      AND deleted_at IS NULL;

    -- A crash after a historical/manual seed could leave more than one global
    -- NULL-org row because the unique key cannot collapse NULLs. Preserve all
    -- assignments by consolidating only duplicate system rows.
    UPDATE devices d
    JOIN snmp_profiles p ON p.id = d.snmp_profile_id
       SET d.snmp_profile_id = v_c_profile_id
     WHERE v_c_profile_id IS NOT NULL
       AND p.organization_id IS NULL
       AND p.is_system = TRUE
       AND p.name = 'Mimosa C5c PTP'
       AND p.deleted_at IS NULL
       AND p.id <> v_c_profile_id;

    UPDATE discovery_results dr
    JOIN snmp_profiles p ON p.id = dr.suggested_profile_id
       SET dr.suggested_profile_id = v_c_profile_id
     WHERE v_c_profile_id IS NOT NULL
       AND p.organization_id IS NULL
       AND p.is_system = TRUE
       AND p.name = 'Mimosa C5c PTP'
       AND p.deleted_at IS NULL
       AND p.id <> v_c_profile_id;

    UPDATE snmp_profiles
       SET status = 'inactive',
           deleted_at = COALESCE(deleted_at, NOW())
     WHERE v_c_profile_id IS NOT NULL
       AND organization_id IS NULL
       AND is_system = TRUE
       AND name = 'Mimosa C5c PTP'
       AND deleted_at IS NULL
       AND id <> v_c_profile_id;

    UPDATE snmp_profiles
       SET manufacturer = 'Mimosa',
           model_pattern = '%C5c%',
           device_type = 'ptp',
           snmp_version = 'v2c',
           poll_interval_sec = 60,
           is_default = FALSE,
           is_system = TRUE,
           status = 'active',
           description = 'Mimosa C5c radios operating in point-to-point/backhaul mode on the 2.x firmware family. Uses the official B5 and C5 product MIB Rev 3.00 plus IF-MIB/IF-X-MIB.'
     WHERE id = v_c_profile_id
       AND organization_id IS NULL
       AND is_system = TRUE
       AND deleted_at IS NULL;

    -- Move only devices already assigned to the legacy/B system profile and
    -- positively identifiable as C5c used for PTP/backhaul. NULL-profile and
    -- PTMP-only C5c records are intentionally left for explicit operator choice.
    UPDATE devices
       SET snmp_profile_id = v_c_profile_id
     WHERE v_b_profile_id IS NOT NULL
       AND v_c_profile_id IS NOT NULL
       AND snmp_profile_id = v_b_profile_id
       AND (type = 'ptp' OR role = 'backhaul')
       AND LOWER(REPLACE(REPLACE(COALESCE(model, ''), '-', ''), ' ', '')) LIKE '%c5c%';

    UPDATE discovery_results
       SET suggested_profile_id = v_c_profile_id
     WHERE v_b_profile_id IS NOT NULL
       AND v_c_profile_id IS NOT NULL
       AND suggested_profile_id = v_b_profile_id
       AND device_type = 'ptp'
       AND LOWER(REPLACE(REPLACE(COALESCE(model, ''), '-', ''), ' ', '')) LIKE '%c5c%';
END$$
DELIMITER ;

CALL migration_463_mimosa_profiles();
DROP PROCEDURE IF EXISTS migration_463_mimosa_profiles;

-- ---------------------------------------------------------------------------
-- Part 2: replace incorrect enterprise rows and upgrade traffic to Counter64
-- ---------------------------------------------------------------------------
UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
   SET spo.deleted_at = NOW()
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NULL
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

-- Upgrade the two legacy standard rows in place. This avoids simultaneous
-- 32-bit and Counter64 sources overwriting the same metric in poll order.
UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
LEFT JOIN snmp_profile_oids existing
       ON existing.profile_id = spo.profile_id
      AND existing.oid = '1.3.6.1.2.1.31.1.1.1.6'
      AND existing.deleted_at IS NULL
   SET spo.oid = '1.3.6.1.2.1.31.1.1.1.6',
       spo.label = 'ifHCInOctets (64-bit)',
       spo.oid_type = 'counter64',
       spo.is_per_interface = TRUE,
       spo.aggregate = FALSE,
       spo.transform = NULL,
       spo.sort_order = 10
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NULL
   AND spo.oid = '1.3.6.1.2.1.2.2.1.10'
   AND existing.id IS NULL;

UPDATE snmp_profile_oids spo
JOIN snmp_profiles p ON p.id = spo.profile_id
LEFT JOIN snmp_profile_oids existing
       ON existing.profile_id = spo.profile_id
      AND existing.oid = '1.3.6.1.2.1.31.1.1.1.10'
      AND existing.deleted_at IS NULL
   SET spo.oid = '1.3.6.1.2.1.31.1.1.1.10',
       spo.label = 'ifHCOutOctets (64-bit)',
       spo.oid_type = 'counter64',
       spo.is_per_interface = TRUE,
       spo.aggregate = FALSE,
       spo.transform = NULL,
       spo.sort_order = 20
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND spo.deleted_at IS NULL
   AND spo.oid = '1.3.6.1.2.1.2.2.1.16'
   AND existing.id IS NULL;

-- ---------------------------------------------------------------------------
-- Part 3: published/field-verified B-series and C5c PTP OID sets
-- ---------------------------------------------------------------------------
INSERT INTO snmp_profile_oids
    (profile_id, oid, metric_column, label, oid_type, is_per_interface,
     aggregate, transform, sort_order)
SELECT p.id, o.oid, o.metric_column, o.label, o.oid_type,
       o.is_per_interface, o.aggregate, o.transform, o.sort_order
FROM snmp_profiles p
JOIN (
    SELECT '1.3.6.1.2.1.1.3.0' AS oid, 'uptime_ticks' AS metric_column,
           'System Uptime (sysUpTime)' AS label, 'timeticks' AS oid_type,
           FALSE AS is_per_interface, FALSE AS aggregate, NULL AS transform,
           5 AS sort_order
    UNION ALL SELECT '1.3.6.1.2.1.31.1.1.1.6', 'if_in_octets',
           'ifHCInOctets (64-bit)', 'counter64', TRUE, FALSE, NULL, 10
    UNION ALL SELECT '1.3.6.1.2.1.31.1.1.1.10', 'if_out_octets',
           'ifHCOutOctets (64-bit)', 'counter64', TRUE, FALSE, NULL, 20
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.14', 'if_in_errors',
           'ifInErrors', 'counter', TRUE, FALSE, NULL, 30
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.20', 'if_out_errors',
           'ifOutErrors', 'counter', TRUE, FALSE, NULL, 40
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.13', 'if_in_discards',
           'ifInDiscards', 'counter', TRUE, FALSE, NULL, 50
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.19', 'if_out_discards',
           'ifOutDiscards', 'counter', TRUE, FALSE, NULL, 60
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.8', 'if_oper_status',
           'ifOperStatus (1=up 2=down)', 'gauge', TRUE, FALSE, NULL, 70
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.1.8.0', 'temperature_c',
           'Mimosa Internal Temperature (C)', 'gauge', FALSE, FALSE,
           'value / 10', 80
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.6.0', 'signal_strength',
           'Mimosa Total Rx Power (dBm)', 'gauge', FALSE, FALSE,
           'value / 10', 90
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1', 'noise_floor_dbm',
           'Mimosa RF Chain 1 Noise (dBm)', 'gauge', FALSE, FALSE,
           'value / 10', 100
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1', 'snr_db',
           'Mimosa RF Chain 1 SNR (dB)', 'gauge', FALSE, FALSE,
           'value / 10', 110
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.7.1.0', 'tx_rate_mbps',
           'Mimosa 5-second Tx Throughput (Mbps)', 'gauge', FALSE, FALSE,
           'value / 100000', 120
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.7.2.0', 'rx_rate_mbps',
           'Mimosa 5-second Rx Throughput (Mbps)', 'gauge', FALSE, FALSE,
           'value / 100000', 130
) o
LEFT JOIN snmp_profile_oids existing
       ON existing.profile_id = p.id
      AND existing.oid = o.oid
      AND existing.deleted_at IS NULL
WHERE p.organization_id IS NULL
  AND p.is_system = TRUE
  AND p.name = 'Mimosa B-series PTP'
  AND p.deleted_at IS NULL
  AND existing.id IS NULL
ON DUPLICATE KEY UPDATE oid = VALUES(oid);

INSERT INTO snmp_profile_oids
    (profile_id, oid, metric_column, label, oid_type, is_per_interface,
     aggregate, transform, sort_order)
SELECT p.id, o.oid, o.metric_column, o.label, o.oid_type,
       o.is_per_interface, o.aggregate, o.transform, o.sort_order
FROM snmp_profiles p
JOIN (
    SELECT '1.3.6.1.2.1.1.3.0' AS oid, 'uptime_ticks' AS metric_column,
           'System Uptime (sysUpTime)' AS label, 'timeticks' AS oid_type,
           FALSE AS is_per_interface, FALSE AS aggregate, NULL AS transform,
           5 AS sort_order
    UNION ALL SELECT '1.3.6.1.2.1.31.1.1.1.6', 'if_in_octets',
           'ifHCInOctets (64-bit)', 'counter64', TRUE, FALSE, NULL, 10
    UNION ALL SELECT '1.3.6.1.2.1.31.1.1.1.10', 'if_out_octets',
           'ifHCOutOctets (64-bit)', 'counter64', TRUE, FALSE, NULL, 20
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.14', 'if_in_errors',
           'ifInErrors', 'counter', TRUE, FALSE, NULL, 30
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.20', 'if_out_errors',
           'ifOutErrors', 'counter', TRUE, FALSE, NULL, 40
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.13', 'if_in_discards',
           'ifInDiscards', 'counter', TRUE, FALSE, NULL, 50
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.19', 'if_out_discards',
           'ifOutDiscards', 'counter', TRUE, FALSE, NULL, 60
    UNION ALL SELECT '1.3.6.1.2.1.2.2.1.8', 'if_oper_status',
           'ifOperStatus (1=up 2=down)', 'gauge', TRUE, FALSE, NULL, 70
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.1.8.0', 'temperature_c',
           'Mimosa Internal Temperature (C)', 'gauge', FALSE, FALSE,
           'value / 10', 80
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.6.0', 'signal_strength',
           'Mimosa Total Rx Power (dBm)', 'gauge', FALSE, FALSE,
           'value / 10', 90
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1', 'noise_floor_dbm',
           'Mimosa RF Chain 1 Noise (dBm)', 'gauge', FALSE, FALSE,
           'value / 10', 100
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1', 'snr_db',
           'Mimosa RF Chain 1 SNR (dB)', 'gauge', FALSE, FALSE,
           'value / 10', 110
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.7.1.0', 'tx_rate_mbps',
           'Mimosa 5-second Tx Throughput (Mbps)', 'gauge', FALSE, FALSE,
           'value / 100000', 120
    UNION ALL SELECT '1.3.6.1.4.1.43356.2.1.2.7.2.0', 'rx_rate_mbps',
           'Mimosa 5-second Rx Throughput (Mbps)', 'gauge', FALSE, FALSE,
           'value / 100000', 130
) o
LEFT JOIN snmp_profile_oids existing
       ON existing.profile_id = p.id
      AND existing.oid = o.oid
      AND existing.deleted_at IS NULL
WHERE p.organization_id IS NULL
  AND p.is_system = TRUE
  AND p.name = 'Mimosa C5c PTP'
  AND p.deleted_at IS NULL
  AND existing.id IS NULL
ON DUPLICATE KEY UPDATE oid = VALUES(oid);

-- Partial-run repair: if HC already existed before the in-place upgrade, the
-- guarded UPDATE above deliberately did not collide with it. Retire only the
-- now-redundant 32-bit source so poll order can never overwrite the same metric.
UPDATE snmp_profile_oids legacy
JOIN snmp_profiles p ON p.id = legacy.profile_id
JOIN snmp_profile_oids hc
  ON hc.profile_id = legacy.profile_id
 AND hc.deleted_at IS NULL
 AND (
      (legacy.oid = '1.3.6.1.2.1.2.2.1.10' AND hc.oid = '1.3.6.1.2.1.31.1.1.1.6')
   OR (legacy.oid = '1.3.6.1.2.1.2.2.1.16' AND hc.oid = '1.3.6.1.2.1.31.1.1.1.10')
 )
   SET legacy.deleted_at = NOW()
 WHERE p.organization_id IS NULL
   AND p.is_system = TRUE
   AND p.name = 'Mimosa B-series PTP'
   AND p.deleted_at IS NULL
   AND legacy.deleted_at IS NULL;

-- Defensive backfill for installs whose cumulative schema omitted migration
-- 265's rollup-state seed. The primary key makes this safe after a normal run.
INSERT INTO snmp_rollup_state (rollup_name, last_processed)
VALUES ('1month', NULL)
ON DUPLICATE KEY UPDATE rollup_name = VALUES(rollup_name);

-- ---------------------------------------------------------------------------
-- Part 4: rebuild every rollup tier with ifOperStatus and all seven RF fields
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS snmp_rollup_to_1hr;
DROP PROCEDURE IF EXISTS snmp_rollup_to_1day;
DROP PROCEDURE IF EXISTS snmp_rollup_to_1month;
DELIMITER $$

-- ---------------------------------------------------------------------------
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
         avg_if_oper_status,     min_if_oper_status,      max_if_oper_status,
         avg_noise_floor_dbm,    min_noise_floor_dbm,     max_noise_floor_dbm,
         avg_air_util_pct,       min_air_util_pct,        max_air_util_pct,
         avg_gps_sync_status,    min_gps_sync_status,     max_gps_sync_status,
         avg_snr_db,             min_snr_db,              max_snr_db,
         avg_ccq_pct,            min_ccq_pct,             max_ccq_pct,
         avg_tx_rate_mbps,       min_tx_rate_mbps,        max_tx_rate_mbps,
         avg_rx_rate_mbps,       min_rx_rate_mbps,        max_rx_rate_mbps,
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
        AVG(if_oper_status),     MIN(if_oper_status),      MAX(if_oper_status),
        AVG(noise_floor_dbm),    MIN(noise_floor_dbm),     MAX(noise_floor_dbm),
        AVG(air_util_pct),       MIN(air_util_pct),        MAX(air_util_pct),
        AVG(gps_sync_status),    MIN(gps_sync_status),     MAX(gps_sync_status),
        AVG(snr_db),             MIN(snr_db),              MAX(snr_db),
        AVG(ccq_pct),            MIN(ccq_pct),             MAX(ccq_pct),
        AVG(tx_rate_mbps),       MIN(tx_rate_mbps),        MAX(tx_rate_mbps),
        AVG(rx_rate_mbps),       MIN(rx_rate_mbps),        MAX(rx_rate_mbps),
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
        avg_if_oper_status     = VALUES(avg_if_oper_status),
        min_if_oper_status     = VALUES(min_if_oper_status),
        max_if_oper_status     = VALUES(max_if_oper_status),
        avg_noise_floor_dbm    = VALUES(avg_noise_floor_dbm),
        min_noise_floor_dbm    = VALUES(min_noise_floor_dbm),
        max_noise_floor_dbm    = VALUES(max_noise_floor_dbm),
        avg_air_util_pct       = VALUES(avg_air_util_pct),
        min_air_util_pct       = VALUES(min_air_util_pct),
        max_air_util_pct       = VALUES(max_air_util_pct),
        avg_gps_sync_status    = VALUES(avg_gps_sync_status),
        min_gps_sync_status    = VALUES(min_gps_sync_status),
        max_gps_sync_status    = VALUES(max_gps_sync_status),
        avg_snr_db             = VALUES(avg_snr_db),
        min_snr_db             = VALUES(min_snr_db),
        max_snr_db             = VALUES(max_snr_db),
        avg_ccq_pct            = VALUES(avg_ccq_pct),
        min_ccq_pct            = VALUES(min_ccq_pct),
        max_ccq_pct            = VALUES(max_ccq_pct),
        avg_tx_rate_mbps       = VALUES(avg_tx_rate_mbps),
        min_tx_rate_mbps       = VALUES(min_tx_rate_mbps),
        max_tx_rate_mbps       = VALUES(max_tx_rate_mbps),
        avg_rx_rate_mbps       = VALUES(avg_rx_rate_mbps),
        min_rx_rate_mbps       = VALUES(min_rx_rate_mbps),
        max_rx_rate_mbps       = VALUES(max_rx_rate_mbps),
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
         avg_if_oper_status,     min_if_oper_status,      max_if_oper_status,
         avg_noise_floor_dbm,    min_noise_floor_dbm,     max_noise_floor_dbm,
         avg_air_util_pct,       min_air_util_pct,        max_air_util_pct,
         avg_gps_sync_status,    min_gps_sync_status,     max_gps_sync_status,
         avg_snr_db,             min_snr_db,              max_snr_db,
         avg_ccq_pct,            min_ccq_pct,             max_ccq_pct,
         avg_tx_rate_mbps,       min_tx_rate_mbps,        max_tx_rate_mbps,
         avg_rx_rate_mbps,       min_rx_rate_mbps,        max_rx_rate_mbps,
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
        AVG(avg_if_oper_status),     MIN(min_if_oper_status),      MAX(max_if_oper_status),
        AVG(avg_noise_floor_dbm),    MIN(min_noise_floor_dbm),     MAX(max_noise_floor_dbm),
        AVG(avg_air_util_pct),       MIN(min_air_util_pct),        MAX(max_air_util_pct),
        AVG(avg_gps_sync_status),    MIN(min_gps_sync_status),     MAX(max_gps_sync_status),
        AVG(avg_snr_db),             MIN(min_snr_db),              MAX(max_snr_db),
        AVG(avg_ccq_pct),            MIN(min_ccq_pct),             MAX(max_ccq_pct),
        AVG(avg_tx_rate_mbps),       MIN(min_tx_rate_mbps),        MAX(max_tx_rate_mbps),
        AVG(avg_rx_rate_mbps),       MIN(min_rx_rate_mbps),        MAX(max_rx_rate_mbps),
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
        avg_if_oper_status     = VALUES(avg_if_oper_status),
        min_if_oper_status     = VALUES(min_if_oper_status),
        max_if_oper_status     = VALUES(max_if_oper_status),
        avg_noise_floor_dbm    = VALUES(avg_noise_floor_dbm),
        min_noise_floor_dbm    = VALUES(min_noise_floor_dbm),
        max_noise_floor_dbm    = VALUES(max_noise_floor_dbm),
        avg_air_util_pct       = VALUES(avg_air_util_pct),
        min_air_util_pct       = VALUES(min_air_util_pct),
        max_air_util_pct       = VALUES(max_air_util_pct),
        avg_gps_sync_status    = VALUES(avg_gps_sync_status),
        min_gps_sync_status    = VALUES(min_gps_sync_status),
        max_gps_sync_status    = VALUES(max_gps_sync_status),
        avg_snr_db             = VALUES(avg_snr_db),
        min_snr_db             = VALUES(min_snr_db),
        max_snr_db             = VALUES(max_snr_db),
        avg_ccq_pct            = VALUES(avg_ccq_pct),
        min_ccq_pct            = VALUES(min_ccq_pct),
        max_ccq_pct            = VALUES(max_ccq_pct),
        avg_tx_rate_mbps       = VALUES(avg_tx_rate_mbps),
        min_tx_rate_mbps       = VALUES(min_tx_rate_mbps),
        max_tx_rate_mbps       = VALUES(max_tx_rate_mbps),
        avg_rx_rate_mbps       = VALUES(avg_rx_rate_mbps),
        min_rx_rate_mbps       = VALUES(min_rx_rate_mbps),
        max_rx_rate_mbps       = VALUES(max_rx_rate_mbps),
        sample_count           = VALUES(sample_count);

    UPDATE snmp_rollup_state
    SET last_processed = TIMESTAMP(v_to_date)
    WHERE rollup_name  = '1day';
END$$

-- ---------------------------------------------------------------------------
-- Procedure: snmp_rollup_to_1month
-- Purpose:   Aggregate daily rows into complete monthly rows. The source
--            daily tier is retained for 90 days; monthly rows retain 3 years.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE snmp_rollup_to_1month()
proc: BEGIN
    DECLARE v_from_date DATE;
    DECLARE v_to_date   DATE;

    SELECT COALESCE(DATE(last_processed), DATE_SUB(CURDATE(), INTERVAL 3 YEAR))
    INTO v_from_date
    FROM snmp_rollup_state
    WHERE rollup_name = '1month';

    SET v_to_date = DATE_FORMAT(CURDATE(), '%Y-%m-01');

    IF v_from_date >= v_to_date THEN
        LEAVE proc;
    END IF;

    INSERT INTO snmp_metrics_1month
        (device_id, interface_id, period_start,
         avg_if_in_octets,       min_if_in_octets,       max_if_in_octets,
         avg_if_out_octets,      min_if_out_octets,      max_if_out_octets,
         avg_if_in_errors,       min_if_in_errors,       max_if_in_errors,
         avg_if_out_errors,      min_if_out_errors,      max_if_out_errors,
         avg_cpu_usage,          min_cpu_usage,          max_cpu_usage,
         avg_memory_usage,       min_memory_usage,       max_memory_usage,
         avg_signal_strength,    min_signal_strength,    max_signal_strength,
         avg_latency_ms,         min_latency_ms,         max_latency_ms,
         avg_voltage_mv,         min_voltage_mv,         max_voltage_mv,
         avg_temperature_c,      min_temperature_c,      max_temperature_c,
         avg_fan_speed_rpm,      min_fan_speed_rpm,      max_fan_speed_rpm,
         avg_if_in_discards,     min_if_in_discards,     max_if_in_discards,
         avg_if_out_discards,    min_if_out_discards,    max_if_out_discards,
         avg_sfp_tx_power_dbm,   min_sfp_tx_power_dbm,   max_sfp_tx_power_dbm,
         avg_sfp_rx_power_dbm,   min_sfp_rx_power_dbm,   max_sfp_rx_power_dbm,
         avg_sfp_temperature_c,  min_sfp_temperature_c,  max_sfp_temperature_c,
         avg_ups_battery_pct,    min_ups_battery_pct,    max_ups_battery_pct,
         avg_ups_runtime_min,    min_ups_runtime_min,    max_ups_runtime_min,
         avg_poe_power_mw,       min_poe_power_mw,       max_poe_power_mw,
         avg_humidity_pct,       min_humidity_pct,       max_humidity_pct,
         avg_if_oper_status,     min_if_oper_status,      max_if_oper_status,
         avg_noise_floor_dbm,    min_noise_floor_dbm,     max_noise_floor_dbm,
         avg_air_util_pct,       min_air_util_pct,        max_air_util_pct,
         avg_gps_sync_status,    min_gps_sync_status,     max_gps_sync_status,
         avg_snr_db,             min_snr_db,              max_snr_db,
         avg_ccq_pct,            min_ccq_pct,             max_ccq_pct,
         avg_tx_rate_mbps,       min_tx_rate_mbps,        max_tx_rate_mbps,
         avg_rx_rate_mbps,       min_rx_rate_mbps,        max_rx_rate_mbps,
         sample_count)
    SELECT
        device_id,
        interface_id,
        DATE_FORMAT(period_start, '%Y-%m-01') AS period_start,
        AVG(avg_if_in_octets),       MIN(min_if_in_octets),       MAX(max_if_in_octets),
        AVG(avg_if_out_octets),      MIN(min_if_out_octets),      MAX(max_if_out_octets),
        AVG(avg_if_in_errors),       MIN(min_if_in_errors),       MAX(max_if_in_errors),
        AVG(avg_if_out_errors),      MIN(min_if_out_errors),      MAX(max_if_out_errors),
        AVG(avg_cpu_usage),          MIN(min_cpu_usage),          MAX(max_cpu_usage),
        AVG(avg_memory_usage),       MIN(min_memory_usage),       MAX(max_memory_usage),
        AVG(avg_signal_strength),    MIN(min_signal_strength),    MAX(max_signal_strength),
        AVG(avg_latency_ms),         MIN(min_latency_ms),         MAX(max_latency_ms),
        AVG(avg_voltage_mv),         MIN(min_voltage_mv),         MAX(max_voltage_mv),
        AVG(avg_temperature_c),      MIN(min_temperature_c),      MAX(max_temperature_c),
        AVG(avg_fan_speed_rpm),      MIN(min_fan_speed_rpm),      MAX(max_fan_speed_rpm),
        AVG(avg_if_in_discards),     MIN(min_if_in_discards),     MAX(max_if_in_discards),
        AVG(avg_if_out_discards),    MIN(min_if_out_discards),    MAX(max_if_out_discards),
        AVG(avg_sfp_tx_power_dbm),   MIN(min_sfp_tx_power_dbm),   MAX(max_sfp_tx_power_dbm),
        AVG(avg_sfp_rx_power_dbm),   MIN(min_sfp_rx_power_dbm),   MAX(max_sfp_rx_power_dbm),
        AVG(avg_sfp_temperature_c),  MIN(min_sfp_temperature_c),  MAX(max_sfp_temperature_c),
        AVG(avg_ups_battery_pct),    MIN(min_ups_battery_pct),    MAX(max_ups_battery_pct),
        AVG(avg_ups_runtime_min),    MIN(min_ups_runtime_min),    MAX(max_ups_runtime_min),
        AVG(avg_poe_power_mw),       MIN(min_poe_power_mw),       MAX(max_poe_power_mw),
        AVG(avg_humidity_pct),       MIN(min_humidity_pct),       MAX(max_humidity_pct),
        AVG(avg_if_oper_status),     MIN(min_if_oper_status),      MAX(max_if_oper_status),
        AVG(avg_noise_floor_dbm),    MIN(min_noise_floor_dbm),     MAX(max_noise_floor_dbm),
        AVG(avg_air_util_pct),       MIN(min_air_util_pct),        MAX(max_air_util_pct),
        AVG(avg_gps_sync_status),    MIN(min_gps_sync_status),     MAX(max_gps_sync_status),
        AVG(avg_snr_db),             MIN(min_snr_db),              MAX(max_snr_db),
        AVG(avg_ccq_pct),            MIN(min_ccq_pct),             MAX(max_ccq_pct),
        AVG(avg_tx_rate_mbps),       MIN(min_tx_rate_mbps),        MAX(max_tx_rate_mbps),
        AVG(avg_rx_rate_mbps),       MIN(min_rx_rate_mbps),        MAX(max_rx_rate_mbps),
        SUM(sample_count)
    FROM snmp_metrics_1day
    WHERE period_start >= v_from_date
      AND period_start <  v_to_date
    GROUP BY device_id, interface_id, DATE_FORMAT(period_start, '%Y-%m-01')
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
        avg_if_oper_status     = VALUES(avg_if_oper_status),
        min_if_oper_status     = VALUES(min_if_oper_status),
        max_if_oper_status     = VALUES(max_if_oper_status),
        avg_noise_floor_dbm    = VALUES(avg_noise_floor_dbm),
        min_noise_floor_dbm    = VALUES(min_noise_floor_dbm),
        max_noise_floor_dbm    = VALUES(max_noise_floor_dbm),
        avg_air_util_pct       = VALUES(avg_air_util_pct),
        min_air_util_pct       = VALUES(min_air_util_pct),
        max_air_util_pct       = VALUES(max_air_util_pct),
        avg_gps_sync_status    = VALUES(avg_gps_sync_status),
        min_gps_sync_status    = VALUES(min_gps_sync_status),
        max_gps_sync_status    = VALUES(max_gps_sync_status),
        avg_snr_db             = VALUES(avg_snr_db),
        min_snr_db             = VALUES(min_snr_db),
        max_snr_db             = VALUES(max_snr_db),
        avg_ccq_pct            = VALUES(avg_ccq_pct),
        min_ccq_pct            = VALUES(min_ccq_pct),
        max_ccq_pct            = VALUES(max_ccq_pct),
        avg_tx_rate_mbps       = VALUES(avg_tx_rate_mbps),
        min_tx_rate_mbps       = VALUES(min_tx_rate_mbps),
        max_tx_rate_mbps       = VALUES(max_tx_rate_mbps),
        avg_rx_rate_mbps       = VALUES(avg_rx_rate_mbps),
        min_rx_rate_mbps       = VALUES(min_rx_rate_mbps),
        max_rx_rate_mbps       = VALUES(max_rx_rate_mbps),
        sample_count           = VALUES(sample_count);

    UPDATE snmp_rollup_state
    SET last_processed = TIMESTAMP(v_to_date)
    WHERE rollup_name  = '1month';
END$$

DELIMITER ;

-- END OF MIGRATION 463
