// =============================================================================
// Connection logging compliance schema (introduced by development migration 457)
// =============================================================================
// RADIUS lifecycle evidence, CGNAT attribution and their retention, as an
// install gets them (the baseline) and as schema.sql mirrors them. The
// migration's own ordering (sink before ALTER, triggers before backfill) and
// its rollback went with the development history: a new install has no rows
// to backfill and the baseline has no rollback.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineTable, baselineColumns, baselineProgram, baselineRows, baselineSql } = require('./helpers/baseline');

const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');
const sql = baselineSql();

describe('connection logging contract', () => {
  test('declares each evidence trigger exactly once, with distinct locals', () => {
    for (const name of [
      'trg_connection_logs_before_insert_org',
      'trg_connection_logs_after_insert_evidence',
      'trg_connection_logs_after_update_evidence',
    ]) {
      expect((sql.match(new RegExp(`CREATE TRIGGER \`${name}\``, 'g')) || [])).toHaveLength(1);
    }
    expect((baselineTable('radius_accounting_events').match(/KEY `idx_radius_events_client_time`/g) || [])).toHaveLength(1);

    const bodies = [
      baselineProgram('trigger', 'trg_connection_logs_after_insert_evidence'),
      baselineProgram('trigger', 'trg_connection_logs_after_update_evidence'),
      ...['trg_connection_logs_after_insert_evidence', 'trg_connection_logs_after_update_evidence']
        .map(name => schema.match(new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?END\\s*(?://|\\$\\$)`))?.[0]),
    ];
    for (const body of bodies) {
      expect(body).toBeDefined();
      const declarations = [...body.matchAll(/DECLARE\s+([a-z_][a-z0-9_]*)/gi)].map(match => match[1].toLowerCase());
      expect(new Set(declarations).size).toBe(declarations.length);
    }
  });

  test('uses bounded milestone evidence and unambiguous canonical hashing', () => {
    const trigger = baselineProgram('trigger', 'trg_connection_logs_after_insert_evidence');
    expect(trigger).toMatch(/v_is_milestone = NEW\.session_instance_id IS NOT NULL[\s\S]*NEW\.event_type IN \('start', 'stop'\)/);
    expect(trigger).toMatch(/JSON_ARRAY\([\s\S]*NEW\.organization_id[\s\S]*NEW\.nas_id[\s\S]*NEW\.username[\s\S]*NEW\.session_instance_id/);
    expect(trigger).toMatch(/NEW\.framed_ipv6_prefix/);
    expect(trigger).toMatch(/NEW\.terminate_cause/);
    expect(trigger).toMatch(/ON DUPLICATE KEY UPDATE id = id/);
    expect(sql).not.toMatch(/INSERT IGNORE INTO `?radius_accounting_events/);
  });

  test('has case-sensitive collector replay identity and future-safe partition maintenance', () => {
    const events = baselineColumns('cgnat_binding_events');
    expect(events.get('exporter_id')).toMatch(/^varchar\(191\) CHARACTER SET ascii COLLATE ascii_bin/);
    expect(events.get('event_id')).toMatch(/^varchar\(191\) CHARACTER SET ascii COLLATE ascii_bin/);
    expect(baselineTable('cgnat_binding_events'))
      .toContain('UNIQUE KEY `uq_cgnat_event_replay` (`organization_id`,`exporter_config_id`,`exporter_boot_id`,`event_id`)');
    expect(baselineProgram('event', 'evt_subscriber_logging_partition_maintenance'))
      .toMatch(/STARTS \(CURRENT_DATE \+ INTERVAL 1 DAY \+ INTERVAL 3 HOUR\)[\s\S]*ON COMPLETION PRESERVE/);
  });

  test('coerces fractional RADIUS timestamps to an integer partition expression', () => {
    const table = baselineTable('radius_accounting_events');
    expect(table).toMatch(/`event_at` timestamp\(3\) NOT NULL/);
    expect(table).toContain('PRIMARY KEY (`id`,`event_at`)');
    expect(table).toContain('PARTITION BY RANGE (floor(unix_timestamp(`event_at`)))');
    expect(baselineProgram('procedure', 'subscriber_logging_maintain_partitions')).toMatch(/v_next_ts = UNIX_TIMESTAMP/);

    const mirror = schema.match(
      /CREATE TABLE IF NOT EXISTS radius_accounting_events \([\s\S]*?PARTITION p_future\s+VALUES LESS THAN MAXVALUE\s*\n\);/,
    )?.[0];
    expect(mirror).toBeDefined();
    expect(mirror).toContain('event_at               TIMESTAMP(3)');
    expect(mirror).toContain('PRIMARY KEY (id, event_at)');
    expect(mirror).toContain('PARTITION BY RANGE (FLOOR(UNIX_TIMESTAMP(event_at)))');
    expect(mirror).not.toContain('PARTITION BY RANGE (UNIX_TIMESTAMP(event_at))');
    expect(schema).toMatch(/CREATE PROCEDURE subscriber_logging_maintain_partitions\(\)[\s\S]*v_next_ts = UNIX_TIMESTAMP/);
  });

  test('adds bounded usage/provenance storage and indexable retention timestamps', () => {
    expect(baselineTable('radius_accounting_usage_daily')).toContain('KEY `idx_radius_usage_date` (`usage_date`)');
    expect(baselineTable('collector_ingest_receipts')).toContain('UNIQUE KEY `uq_collector_receipt_bucket`');
    const connectionLogs = baselineTable('connection_logs');
    expect(connectionLogs).toContain('KEY `idx_conn_logs_retention` (`retention_at`)');
    expect(connectionLogs).toContain('KEY `idx_conn_logs_org_retention` (`organization_id`,`retention_at`)');
    expect(baselineRows('scheduled_tasks').some(t => t.task_name === 'purge_radius_accounting')).toBe(true);
    expect(schema).toMatch(/INSERT INTO scheduled_tasks[\s\S]*purge_radius_accounting[\s\S]*configured calendar-month retention/);
  });

  test('adds stable API-token provenance to sensitive report access records', () => {
    expect(baselineColumns('report_access_logs').has('api_token_id')).toBe(true);
    expect(baselineTable('report_access_logs')).toContain('KEY `idx_report_access_logs_api_token`');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS report_access_logs[\s\S]*api_token_id[\s\S]*idx_report_access_logs_api_token/);
  });

  test('grants sensitive permissions only to the intended roles', () => {
    const roles = new Map(baselineRows('roles').map(r => [r.id, r.name]));
    const permissions = new Map(baselineRows('permissions').map(p => [p.name, p.id]));
    const holders = slug => baselineRows('role_permissions')
      .filter(rp => rp.permission_id === permissions.get(slug)).map(rp => roles.get(rp.role_id)).sort();
    expect(holders('connection_logs.ingest')).toEqual(expect.arrayContaining(['admin']));
    expect(holders('connection_logs.ingest')).not.toContain('support');
    expect(holders('ip_attribution.export')).toEqual(expect.arrayContaining(['admin']));
    expect(holders('connection_logs.export')).toContain('auditor');
    expect(schema).toMatch(/INSERT IGNORE INTO role_permissions[\s\S]*connection_logs\.ingest[\s\S]*WHERE r\.name IN \('admin', 'super_admin'\)\s+AND r\.deleted_at IS NULL;/);
    expect(schema).toMatch(/INSERT IGNORE INTO role_permissions[\s\S]*connection_logs\.export[\s\S]*WHERE r\.name = 'auditor'\s+AND r\.deleted_at IS NULL;/);
  });

  test('does not weaken source-only FreeRADIUS/SNMP business-key uniqueness in shared databases', () => {
    expect(schema).toContain('UNIQUE KEY uq_nas_ip_address (ip_address, active_flag)');
    expect(schema).toContain('UNIQUE KEY uq_radius_username (username, active_flag)');
    expect(baselineTable('nas')).toContain('UNIQUE KEY `uq_nas_ip_address` (`ip_address`,`active_flag`)');
    expect(baselineTable('radius')).toContain('UNIQUE KEY `uq_radius_username` (`username`,`active_flag`)');
    expect(sql).not.toContain('organization_unique_scope');
  });

  test('fresh schema mirrors the new tables, trigger semantics, and safe partition schedule', () => {
    for (const table of [
      'radius_accounting_events', 'cgnat_attribution_bindings', 'cgnat_binding_events',
      'ip_attribution_case_evidence', 'radius_accounting_usage_daily', 'collector_ingest_receipts',
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(() => baselineTable(table)).not.toThrow();
    }
    expect(schema).toContain('CREATE TRIGGER trg_connection_logs_after_update_evidence');
    expect(schema).toMatch(/DROP PROCEDURE IF EXISTS connection_logs_maintain_partitions;[\s\S]*CREATE PROCEDURE connection_logs_maintain_partitions\(\)[\s\S]*CALL connection_logs_maintain_partitions\(\);[\s\S]*CREATE EVENT IF NOT EXISTS evt_connection_logs_partition_maintenance/);
    expect(schema).toMatch(/evt_subscriber_logging_partition_maintenance[\s\S]*STARTS \(CURRENT_DATE \+ INTERVAL 1 DAY \+ INTERVAL 3 HOUR\)/);
    expect(schema).toMatch(/consistency marker; not tamper-proof/i);
    // The baseline runs the partition maintenance before creating its event.
    expect(sql.indexOf('CALL connection_logs_maintain_partitions();'))
      .toBeLessThan(sql.indexOf('CREATE EVENT `evt_connection_logs_partition_maintenance`'));
  });

  test('pins the RADIUS chain, corrected clock horizon, and one collector token per epoch', () => {
    const logs = baselineColumns('connection_logs');
    expect(logs.has('attribution_evidence_complete')).toBe(true);
    expect(logs.has('attribution_anomaly_reason')).toBe(true);
    expect(sql).toContain('radius_evidence_integrity_hash');
    expect(sql).toContain('radius_evidence_observed_at');
    expect(sql).toContain('last_corrected_device_at');
    expect(sql).toContain('coverage_horizon_at');
    expect(sql).toContain('recovery_collector_api_token_id');
    expect(sql).toContain('UNIQUE KEY `uq_cgnat_exporter_collector_token`');
    expect(sql).toContain('UNIQUE KEY `uq_cgnat_exporter_recovery_token`');
    expect(baselineProgram('trigger', 'trg_connection_logs_after_update_evidence')).toMatch(/NEW\.calling_station_id <=> OLD\.calling_station_id/);
    expect(baselineTable('cgnat_binding_events')).toMatch(/FOREIGN KEY \(`binding_id`, ?`organization_id`\)[^\n]*ON DELETE CASCADE/);
  });
});
