// =============================================================================
// VigaBSS 5.0 — Data Residency Validation Schemas
// =============================================================================
// The routes had none: a body without primary_storage_country bound undefined
// and failed with a 500, and a destination list reached the JSON column as
// whatever was sent.
// =============================================================================

const COUNTRY = /^[A-Z]{2}$/;

const saveDataResidency = {
  primary_storage_country: { type: 'string', pattern: COUNTRY },
  primary_storage_region: { type: 'string', max: 100 },
  backup_storage_country: { type: 'string', pattern: COUNTRY },
  backup_storage_region: { type: 'string', max: 100 },
  cross_border_transfers_allowed: { type: 'boolean' },
  cross_border_destinations: { type: 'array' },
  dr_site_country: { type: 'string', pattern: COUNTRY },
  dr_site_region: { type: 'string', max: 100 },
  notes: { type: 'string', max: 65535 },
};

module.exports = { saveDataResidency };
