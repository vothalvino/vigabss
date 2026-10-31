// =============================================================================
// VigaBSS 5.0 — ProtocolShapingRule Validation Schemas
// =============================================================================

// Names, ports and marks are written into exported RouterOS scripts.
const { SAFE_NAME_PATTERN, PORT_RANGE_PATTERN, blankOr } = require('../../utils/routerosScript');

const createProtocolShapingRule = {
  plan_id: { type: 'number', min: 1 },
  name: { type: 'string', required: true, min: 1, max: 100, pattern: SAFE_NAME_PATTERN },
  description: { type: 'string', max: 5000 },
  protocol: { type: 'string', enum: ['tcp', 'udp', 'icmp', 'any'] },
  direction: { type: 'string', enum: ['download', 'upload', 'both'] },
  dst_port_range: { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  src_port_range: { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  l7_pattern: { type: 'string', max: 255 },
  action: { type: 'string', enum: ['limit', 'drop', 'mark', 'throttle'] },
  limit_download_mbps: { type: 'number', min: 0 },
  limit_upload_mbps: { type: 'number', min: 0 },
  dscp_mark: { type: 'string', max: 20 },
  priority: { type: 'number', min: 1, max: 255 },
  enabled: { type: 'boolean' },
  preset: { type: 'string', max: 50 },
};

const updateProtocolShapingRule = {
  plan_id: { type: 'number', min: 1 },
  name: { type: 'string', min: 1, max: 100, pattern: SAFE_NAME_PATTERN },
  description: { type: 'string', max: 5000 },
  protocol: { type: 'string', enum: ['tcp', 'udp', 'icmp', 'any'] },
  direction: { type: 'string', enum: ['download', 'upload', 'both'] },
  dst_port_range: { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  src_port_range: { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  l7_pattern: { type: 'string', max: 255 },
  action: { type: 'string', enum: ['limit', 'drop', 'mark', 'throttle'] },
  limit_download_mbps: { type: 'number', min: 0 },
  limit_upload_mbps: { type: 'number', min: 0 },
  dscp_mark: { type: 'string', max: 20 },
  priority: { type: 'number', min: 1, max: 255 },
  enabled: { type: 'boolean' },
  preset: { type: 'string', max: 50 },
};

module.exports = { createProtocolShapingRule, updateProtocolShapingRule };
