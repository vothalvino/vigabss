'use strict';

// =============================================================================
// VigaBSS 5.0 — DSCP Marking Policy Validation Schemas (§10.4)
// =============================================================================

// Names, ports and marks are written into exported RouterOS scripts.
const { SAFE_NAME_PATTERN, PORT_RANGE_PATTERN, MARK_PATTERN, blankOr } = require('../../utils/routerosScript');

const createDscpMarkingPolicy = {
  name:             { type: 'string', required: true, min: 1, max: 100, pattern: SAFE_NAME_PATTERN },
  description:      { type: 'string', max: 1000 },
  dscp_value:       { type: 'number', required: true, min: 0, max: 63 },
  dscp_name:        { type: 'string', max: 20, pattern: blankOr(MARK_PATTERN) },
  traffic_class:    { type: 'string', max: 50 },
  match_protocol:   { type: 'string', enum: ['tcp', 'udp', 'icmp', 'any'] },
  match_dst_port:   { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  match_src_port:   { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  match_l7:         { type: 'string', max: 255 },
  action:           { type: 'string', enum: ['mark', 'remark', 'passthrough', 'trust', 'police'] },
  priority:         { type: 'number', min: 1, max: 255 },
  enabled:          { type: 'number', min: 0, max: 1 },
  status:           { type: 'string', enum: ['active', 'inactive'] },
};

const updateDscpMarkingPolicy = {
  name:             { type: 'string', min: 1, max: 100, pattern: SAFE_NAME_PATTERN },
  description:      { type: 'string', max: 1000 },
  dscp_value:       { type: 'number', min: 0, max: 63 },
  dscp_name:        { type: 'string', max: 20, pattern: blankOr(MARK_PATTERN) },
  traffic_class:    { type: 'string', max: 50 },
  match_protocol:   { type: 'string', enum: ['tcp', 'udp', 'icmp', 'any'] },
  match_dst_port:   { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  match_src_port:   { type: 'string', max: 100, pattern: blankOr(PORT_RANGE_PATTERN) },
  match_l7:         { type: 'string', max: 255 },
  action:           { type: 'string', enum: ['mark', 'remark', 'passthrough', 'trust', 'police'] },
  priority:         { type: 'number', min: 1, max: 255 },
  enabled:          { type: 'number', min: 0, max: 1 },
  status:           { type: 'string', enum: ['active', 'inactive'] },
};

module.exports = { createDscpMarkingPolicy, updateDscpMarkingPolicy };
