// =============================================================================
// VigaBSS 5.0 — Suspension Rule Validation Schemas
// =============================================================================

// Field names match database/schema.sql's suspension_rules columns exactly —
// `validate()` silently drops any field not declared here, so `is_enabled` /
// `notify_days_before` (the real columns are `is_active` / `notify_before_days`)
// meant every create/update request lost the flag the operator actually set.
// Only actions the scheduler carries out (suspensionService.ENFORCED_RULE_ACTIONS).
// 'notify_only' and 'auto_disconnect' used to be accepted and then silently
// did nothing; use notify_before_days for advance notices instead.
const RULE_ACTIONS = ['auto_suspend', 'soft_suspend', 'walled_garden'];

const createSuspensionRule = {
  name: { type: 'string', required: true, min: 1, max: 255 },
  days_past_due: { type: 'number', required: true, min: 1 },
  grace_period_days: { type: 'number', min: 0 },
  action: { type: 'string', required: true, enum: RULE_ACTIONS },
  notify_before_days: { type: 'number', min: 0 },
  apply_to_plan_ids: { type: 'array' },
  is_active: { type: 'boolean' },
  soft_suspend_download_kbps: { type: 'number', min: 1 },
  soft_suspend_upload_kbps: { type: 'number', min: 1 },
};

const updateSuspensionRule = {
  name: { type: 'string', min: 1, max: 255 },
  days_past_due: { type: 'number', min: 1 },
  grace_period_days: { type: 'number', min: 0 },
  action: { type: 'string', enum: RULE_ACTIONS },
  notify_before_days: { type: 'number', min: 0 },
  apply_to_plan_ids: { type: 'array' },
  is_active: { type: 'boolean' },
  soft_suspend_download_kbps: { type: 'number', min: 1 },
  soft_suspend_upload_kbps: { type: 'number', min: 1 },
};

module.exports = { createSuspensionRule, updateSuspensionRule };
