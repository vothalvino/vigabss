'use strict';

// =============================================================================
// VigaBSS 5.0 — IPv6 Transition Mechanism Validation Schemas
// =============================================================================
// One schema per table: a shared one required only the name, so a 6rd tunnel
// without its border relay (or a DS-Lite without its AFTR, …) failed the
// INSERT on a NOT NULL column with a 500.
// =============================================================================

const COMMON = {
  name: { type: 'string', required: true, min: 1, max: 100 },
  status: { type: 'string', enum: ['active', 'inactive'] },
  notes: { type: 'string', max: 5000 },
};

const createTunnel6rdConfig = {
  ...COMMON,
  border_relay_ip: { type: 'string', required: true, min: 1, max: 45 },
  ipv6_prefix: { type: 'string', required: true, min: 1, max: 50 },
  ipv4_mask_len: { type: 'number', min: 0, max: 32 },
  mtu: { type: 'number', min: 576, max: 9000 },
};

const createDsLiteConfig = {
  ...COMMON,
  aftr_address: { type: 'string', required: true, min: 1, max: 45 },
  b4_address_range: { type: 'string', max: 50 },
  mtu: { type: 'number', min: 576, max: 9000 },
};

const createMapRule = {
  ...COMMON,
  rule_type: { type: 'string', enum: ['map-e', 'map-t'] },
  ipv6_prefix: { type: 'string', required: true, min: 1, max: 50 },
  ipv4_prefix: { type: 'string', required: true, min: 1, max: 50 },
  ea_bits_len: { type: 'number', min: 0, max: 48 },
  br_address: { type: 'string', required: true, min: 1, max: 45 },
};

const createXlat464Config = {
  ...COMMON,
  plat_prefix: { type: 'string', required: true, min: 1, max: 50 },
  clat_prefix: { type: 'string', max: 50 },
  dns64_prefix: { type: 'string', max: 50 },
};

// An update sends only what changes; nothing is required.
const optional = schema => Object.fromEntries(Object.entries(schema)
  .map(([field, { required: _required, ...rules }]) => [field, rules]));

module.exports = {
  createTunnel6rdConfig,
  updateTunnel6rdConfig: optional(createTunnel6rdConfig),
  createDsLiteConfig,
  updateDsLiteConfig: optional(createDsLiteConfig),
  createMapRule,
  updateMapRule: optional(createMapRule),
  createXlat464Config,
  updateXlat464Config: optional(createXlat464Config),
};
