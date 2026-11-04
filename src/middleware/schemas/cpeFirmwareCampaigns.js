// =============================================================================
// VigaBSS 5.0 — CPE Firmware Campaign Validation Schemas (§8.1)
// =============================================================================

const createCpeFirmwareCampaign = {
  name: { type: 'string', required: true, min: 1, max: 100 },
  firmware_version_id: { type: 'number', required: true, min: 1 },
  target_manufacturer: { type: 'string', max: 100 },
  target_model: { type: 'string', max: 100 },
  target_profile_id: { type: 'number', min: 1 },
  target_device_ids: { type: 'object' },
  scheduled_at: { type: 'string', max: 30 },
  notes: { type: 'string', max: 10000 },
};

const updateCpeFirmwareCampaign = {
  name: { type: 'string', min: 1, max: 100 },
  firmware_version_id: { type: 'number', min: 1 },
  target_manufacturer: { type: 'string', max: 100 },
  target_model: { type: 'string', max: 100 },
  target_profile_id: { type: 'number', min: 1 },
  target_device_ids: { type: 'object' },
  // No status: start and cancel have their own routes (NET-26).
  scheduled_at: { type: 'string', max: 30 },
  notes: { type: 'string', max: 10000 },
};

module.exports = { createCpeFirmwareCampaign, updateCpeFirmwareCampaign };
