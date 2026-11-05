'use strict';
// =============================================================================
// Notification resolution state (introduced by development migration 453)
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineColumns, baselineTable } = require('./helpers/baseline');

describe('notification resolution state', () => {
  it('has restart-safe resolved_at columns and a selective index, mirrored in the canonical schema', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');
    expect(baselineColumns('notifications').get('resolved_at')).toMatch(/^datetime/);
    expect(baselineColumns('ops_alert_deliveries').get('resolved_at')).toMatch(/^datetime/);
    expect(baselineTable('notifications')).toContain('KEY `idx_notifications_entity_resolution` (`entity_type`,`resolved_at`,`deleted_at`)');
    expect(baselineTable('ops_alert_deliveries')).toMatch(/KEY `idx_ops_alert_deliveries_resolved_at`/);
    expect(baselineTable('notifications')).not.toMatch(/KEY `idx_notifications_resolved_at` \(`resolved_at`\)/);

    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS notifications[\s\S]*resolved_at DATETIME/);
    expect(schema).toMatch(/KEY idx_notifications_entity_resolution \(entity_type, resolved_at, deleted_at\)/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS ops_alert_deliveries[\s\S]*resolved_at DATETIME/);
    expect(schema).not.toMatch(/KEY idx_notifications_resolved_at \(resolved_at\)/);
  });
});
