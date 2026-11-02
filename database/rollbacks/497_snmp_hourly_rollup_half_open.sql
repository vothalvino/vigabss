-- =============================================================================
-- Rollback 497 — restore migration 463's hourly rollup window
-- =============================================================================
-- Samples polled exactly on the hour are excluded again.
-- =============================================================================

DROP PROCEDURE IF EXISTS snmp_rollup_to_1hr;
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

DELIMITER ;
