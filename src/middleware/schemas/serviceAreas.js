// =============================================================================
// VigaBSS 5.0 — Service Area Validation Schemas
// =============================================================================

// boundary is a GeoJSON Polygon, stored as a POLYGON (SRID 4326). It was a
// string bound into the geometry column as is, so every create failed in
// MySQL with a 500.
const createServiceArea = {
  name: { type: 'string', required: true, min: 1, max: 150 },
  description: { type: 'string', max: 5000 },
  boundary: { type: 'object', required: true },
  color: { type: 'string', max: 7 },
  status: { type: 'string', enum: ['planned', 'active', 'retired'] },
};

const updateServiceArea = {
  name: { type: 'string', min: 1, max: 150 },
  description: { type: 'string', max: 5000 },
  boundary: { type: 'object' },
  color: { type: 'string', max: 7 },
  status: { type: 'string', enum: ['planned', 'active', 'retired'] },
};

module.exports = { createServiceArea, updateServiceArea };
