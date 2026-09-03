// =============================================================================
// VigaBSS 5.0 — Alert Validation Schemas
// =============================================================================

const ALERT_METRICS = [
  'cpu_usage', 'memory_usage', 'signal_strength', 'latency_ms',
  'packet_loss', 'uptime', 'if_in_octets', 'if_out_octets',
  'voltage_mv', 'temperature_c', 'fan_speed_rpm',
  'if_in_discards', 'if_out_discards',
  'sfp_tx_power_dbm', 'sfp_rx_power_dbm', 'sfp_temperature_c',
  'ups_battery_pct', 'ups_runtime_min', 'poe_power_mw', 'humidity_pct',
  'noise_floor_dbm', 'air_util_pct', 'gps_sync_status', 'snr_db',
  'ccq_pct', 'tx_rate_mbps', 'rx_rate_mbps',
];
const ALERT_OPERATORS = ['>', '>=', '<', '<=', '=='];
const ALERT_SEVERITIES = ['info', 'warning', 'major', 'critical'];

const createRule = {
  name: { type: 'string', required: true, min: 1, max: 200 },
  description: { type: 'string', required: false },
  metric: { type: 'string', required: true, enum: ALERT_METRICS },
  operator: { type: 'string', required: false, enum: ALERT_OPERATORS },
  threshold: { type: 'number', required: true },
  device_id: { type: 'number', required: false, min: 1 },
  duration_minutes: { type: 'number', required: false, min: 1 },
  severity: { type: 'string', required: false, enum: ALERT_SEVERITIES },
  auto_create_outage: { type: 'boolean', required: false },
  auto_create_ticket: { type: 'boolean', required: false },
  is_enabled: { type: 'boolean', required: false },
};

const updateRule = {
  name: { type: 'string', required: false, min: 1, max: 200 },
  description: { type: 'string', required: false },
  metric: { type: 'string', required: false, enum: ALERT_METRICS },
  operator: { type: 'string', required: false, enum: ALERT_OPERATORS },
  threshold: { type: 'number', required: false },
  device_id: { type: 'number', required: false, min: 1 },
  duration_minutes: { type: 'number', required: false, min: 1 },
  severity: { type: 'string', required: false, enum: ALERT_SEVERITIES },
  auto_create_outage: { type: 'boolean', required: false },
  auto_create_ticket: { type: 'boolean', required: false },
  is_enabled: { type: 'boolean', required: false },
};

module.exports = { createRule, updateRule };
