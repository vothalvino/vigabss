// =============================================================================
// VigaBSS 5.0 — Point zone validation schemas
// =============================================================================

const zoneSchema = {
  name: { type: 'string', required: true, min: 1, max: 100 },
};

// zone_id null takes the point out of its zone.
const assignZoneSchema = {
  zone_id: { type: 'number', min: 1 },
};

module.exports = { zoneSchema, assignZoneSchema };
