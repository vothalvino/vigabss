// =============================================================================
// VigaBSS 5.0 — ONU Detail Validation Schemas (§7.2)
// =============================================================================

const createOnuDetail = {
  device_id: { type: 'number', required: true, min: 1 },
  olt_device_id: { type: 'number', min: 1 },
  olt_port_id: { type: 'number', min: 1 },
  onu_profile_id: { type: 'number', min: 1 },
  serial_number: { type: 'string', max: 20 },
  loid: { type: 'string', max: 64 },
  // Write-only; sealed into loid_password_encrypted by the route (NET-10).
  loid_password: { type: 'string', max: 64 },
  onu_state: { type: 'string', enum: ['online', 'offline', 'los', 'dying_gasp', 'power_off', 'loc', 'unconfigured', 'unknown'] },
  onu_id: { type: 'number', min: 0, max: 127 },
  ranging_distance_m: { type: 'number', min: 0 },
  line_profile_name: { type: 'string', max: 100 },
  service_profile_name: { type: 'string', max: 100 },
  wan_mode: { type: 'string', enum: ['bridge', 'router', 'mixed'] },
  notes: { type: 'string', max: 1000 },
};

const updateOnuDetail = {
  olt_device_id: { type: 'number', min: 1 },
  olt_port_id: { type: 'number', min: 1 },
  onu_profile_id: { type: 'number', min: 1 },
  serial_number: { type: 'string', max: 20 },
  loid: { type: 'string', max: 64 },
  // Write-only; sealed into loid_password_encrypted by the route (NET-10).
  loid_password: { type: 'string', max: 64 },
  onu_state: { type: 'string', enum: ['online', 'offline', 'los', 'dying_gasp', 'power_off', 'loc', 'unconfigured', 'unknown'] },
  onu_id: { type: 'number', min: 0, max: 127 },
  ranging_distance_m: { type: 'number', min: 0 },
  line_profile_name: { type: 'string', max: 100 },
  service_profile_name: { type: 'string', max: 100 },
  wan_mode: { type: 'string', enum: ['bridge', 'router', 'mixed'] },
  notes: { type: 'string', max: 1000 },
};

const patchOnuDetail = Object.fromEntries(
  Object.entries(updateOnuDetail).map(([k, v]) => [k, { ...v, required: false }]),
);

module.exports = { createOnuDetail, updateOnuDetail, patchOnuDetail };
