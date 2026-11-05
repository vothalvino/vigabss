'use strict';
// =============================================================================
// PPPoE diagnostics telemetry (introduced by development migration 455)
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineColumns, baselineTable, baselineRows } = require('./helpers/baseline');

describe('PPPoE diagnostics telemetry', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');

  test('radpostauth carries tenant, NAS and reason ownership, indexed', () => {
    const columns = baselineColumns('radpostauth');
    expect(columns.get('organization_id')).toMatch(/^bigint unsigned DEFAULT NULL/);
    expect(columns.get('nas_id')).toMatch(/^bigint unsigned DEFAULT NULL/);
    expect(columns.get('reason_code')).toMatch(/^varchar\(50\) .*DEFAULT NULL/);
    const table = baselineTable('radpostauth');
    expect(table).toContain('KEY `idx_radpostauth_org_authdate` (`organization_id`,`authdate`)');
    expect(table).toContain('KEY `idx_radpostauth_nas_id` (`nas_id`)');
    expect(table).toContain('KEY `idx_radpostauth_reason_code` (`reason_code`)');

    for (const definition of ['organization_id BIGINT UNSIGNED NULL', 'nas_id BIGINT UNSIGNED NULL', 'reason_code VARCHAR(50) NULL']) {
      expect(schema).toContain(definition);
    }
    expect(schema).toMatch(/KEY idx_radpostauth_org_authdate \(organization_id, authdate\)/);
    expect(schema).toMatch(/KEY idx_radpostauth_nas_id \(nas_id\)/);
    expect(schema).toMatch(/KEY idx_radpostauth_reason_code \(reason_code\)/);
  });

  test('pppoe_event_logs has the nullable per-NAS source dedupe key', () => {
    expect(baselineColumns('pppoe_event_logs').get('source_key')).toMatch(/^char\(64\) .*DEFAULT NULL/);
    const table = baselineTable('pppoe_event_logs');
    expect(table).toContain('UNIQUE KEY `uq_pppoe_event_logs_nas_source` (`nas_id`,`source_key`)');
    expect(table).toContain('KEY `idx_pppoe_event_logs_org_logged_at` (`organization_id`,`logged_at`)');
    expect(schema).toMatch(/source_key CHAR\(64\) NULL/);
    expect(schema).toMatch(/UNIQUE KEY uq_pppoe_event_logs_nas_source \(nas_id, source_key\)/);
    expect(schema).toMatch(/KEY idx_pppoe_event_logs_org_logged_at \(organization_id, logged_at\)/);
  });

  test('seeds exactly one global five-minute poll task with a valid priority', () => {
    const tasks = baselineRows('scheduled_tasks').filter(t => t.task_name === 'poll_pppoe_events');
    expect(tasks).toEqual([expect.objectContaining({
      organization_id: null, cron_expression: '*/5 * * * *', priority: 'normal', timeout_seconds: 3600,
    })]);
    expect(schema).toMatch(/'poll_pppoe_events'[\s\S]*'\*\/5 \* \* \* \*'/);
    expect(schema).toMatch(/priority, timeout_seconds\)[\s\S]*'normal',\s*3600/);
    expect(schema).toMatch(/operational metadata, not a hard runner deadline/);
    expect(schema).toMatch(/Runtime\/stuck threshold metadata in seconds; enforcement is handler-specific/);
  });
});
