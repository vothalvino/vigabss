'use strict';

// =============================================================================
// VigaBSS 5.0 — MPLS/VLAN Prioritization Rule Validation Schemas (§10.4)
// =============================================================================
// Fields and rule types are the columns and ENUM of
// mpls_vlan_prioritization_rules (FE2-03).

const RULE_TYPES = ['mpls_exp', 'dot1p', 'dscp_to_dot1p', 'dot1p_to_dscp', 'combined'];

const fields = {
  description:         { type: 'string', max: 1000 },
  rule_type:           { type: 'string', enum: RULE_TYPES },
  match_vlan_id:       { type: 'number', min: 0, max: 4094 },
  match_inner_vlan_id: { type: 'number', min: 0, max: 4094 },
  match_dscp:          { type: 'number', min: 0, max: 63 },
  match_dot1p:         { type: 'number', min: 0, max: 7 },
  set_mpls_exp:        { type: 'number', min: 0, max: 7 },
  set_dot1p:           { type: 'number', min: 0, max: 7 },
  set_dscp:            { type: 'number', min: 0, max: 63 },
  priority:            { type: 'number', min: 0, max: 255 },
  enabled:             { type: 'number', min: 0, max: 1 },
};

const createMplsVlanRule = {
  name:                { type: 'string', required: true, min: 1, max: 100 },
  ...fields,
};

const updateMplsVlanRule = {
  name:                { type: 'string', min: 1, max: 100 },
  ...fields,
};

module.exports = { createMplsVlanRule, updateMplsVlanRule };
