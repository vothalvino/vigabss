// =============================================================================
// VigaBSS 5.0 — Scheduled Task Validation Schemas
// =============================================================================

// scheduled_tasks.task_type is a category, and the database ENUM is the list
// (FE2-13). The handler a task runs is chosen by task_name. This list offered
// populate_revenue_summary, csd_expiry_monitor and three more names that the
// ENUM does not have, so creating such a task failed in MySQL with a 500.
const TASK_TYPES = [
  'auto_suspend', 'generate_invoice', 'radius_sync', 'snmp_poll', 'usage_rollup', 'cleanup',
  'notification', 'backup', 'maintenance', 'webhook_retry', 'other',
];

const createScheduledTask = {
  task_name: { type: 'string', required: true, min: 1, max: 100 },
  task_type: { type: 'string', required: true, enum: TASK_TYPES },
  cron_expression: { type: 'string', required: true, max: 100 },
  description: { type: 'string', max: 500 },
  payload: { type: 'string', max: 5000 },
  priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
  is_enabled: { type: 'boolean' },
};

const updateScheduledTask = {
  task_name: { type: 'string', min: 1, max: 100 },
  cron_expression: { type: 'string', max: 100 },
  description: { type: 'string', max: 500 },
  payload: { type: 'string', max: 5000 },
  priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
  is_enabled: { type: 'boolean' },
};

module.exports = { TASK_TYPES, createScheduledTask, updateScheduledTask };
