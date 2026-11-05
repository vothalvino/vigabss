'use strict';
// =============================================================================
// Durable SNMP trap forwarding (introduced by development migration 459)
// =============================================================================
// The DDL contract is asserted on schema.sql, which mirrors 459 in the same
// SQL style; the triggers on both the baseline (what installs get) and
// schema.sql; the baseline's columns and grants directly. 459's one-off work
// on existing data (pausing old rules, scrubbing historical audit snapshots,
// community strings and payloads) and its rollback went with the development
// history: a new install has no such rows.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineSql, baselineColumns, baselineTable, baselineRows } = require('./helpers/baseline');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const schema = read('database/schema.sql');
// The baseline's programs in schema.sql's spelling: no identifier quotes, and
// `END$$` where the baseline closes a program with `END ;;`.
const baselinePrograms = baselineSql().replace(/`(\w+)`/g, '$1').replace(/END ;;/g, 'END$$$$');

function deliveryDefinition(source) {
  const match = source.match(
    /CREATE TABLE (?:IF NOT EXISTS )?snmp_trap_forwarding_deliveries \([\s\S]*?\n\) ENGINE=InnoDB/,
  );
  expect(match).toBeDefined();
  return match[0];
}

function usageDefinition(source) {
  const match = source.match(
    /CREATE TABLE (?:IF NOT EXISTS )?snmp_trap_ingest_daily_usage \([\s\S]*?\n\) ENGINE=InnoDB/,
  );
  expect(match).toBeDefined();
  return match[0];
}

function trigger(source, name, timing, table) {
  const found = source.match(new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?${timing} ON ${table}[\\s\\S]*?END\\$\\$`));
  expect(found).toBeDefined();
  return found[0];
}

describe('durable SNMP trap forwarding', () => {
  test('stale or unreviewed rules cannot become eligible to forward', () => {
    expect(schema).toMatch(/configuration_reviewed_at\s+DATETIME\s+NULL[\s\S]*?secure (?:API )?validator/i);
    expect(baselineColumns('snmp_trap_forwarding_rules').get('configuration_reviewed_at')).toMatch(/^datetime DEFAULT NULL .*secure (?:API )?validator/i);
    for (const source of [baselinePrograms, schema]) {
      const body = trigger(source, 'trg_stfr_clear_review_bu', 'BEFORE UPDATE', 'snmp_trap_forwarding_rules');
      for (const field of ['match_trap_type', 'match_source_ip', 'match_oid_prefix', 'forward_to_url', 'forward_to_email']) {
        expect(body).toMatch(new RegExp(`BINARY\\s+NEW\\.${field}\\s+<=>\\s+BINARY\\s+OLD\\.${field}`));
      }
      for (const field of ['forward_to_webhook_id', 'is_active']) {
        expect(body).toMatch(new RegExp(`NEW\\.${field}\\s+<=>\\s+OLD\\.${field}`));
      }
      expect(body).toMatch(/SET NEW\.configuration_reviewed_at = NULL/);
    }

    const service = read('src/services/trapForwardingService.js');
    expect(service).toMatch(
      /WHERE organization_id = \? AND is_active = 1 AND deleted_at IS NULL\s+AND configuration_reviewed_at IS NOT NULL/,
    );
  });

  test('treats URL capability tokens as binary identities in webhook mutation triggers', () => {
    for (const source of [baselinePrograms, schema]) {
      const body = trigger(source, 'trg_webhooks_cancel_trap_unclaimed_bu', 'AFTER UPDATE', 'webhooks');
      expect(body).toMatch(/NOT \(BINARY NEW\.url <=> BINARY OLD\.url\)/);
      expect(body).toMatch(/UPDATE snmp_trap_forwarding_deliveries/);
      expect(body).toMatch(/UPDATE webhook_deliveries/);
    }
  });

  test('creates tenant-owned durable outcomes with bounded retry state', () => {
    const definition = deliveryDefinition(schema);
    expect(definition).toMatch(/organization_id\s+BIGINT UNSIGNED NOT NULL/);
    expect(definition).toMatch(/status\s+ENUM\('pending','processing','retrying','success','dead_letter','cancelled'\)/);
    expect(definition).toMatch(/attempt_number\s+TINYINT UNSIGNED NOT NULL DEFAULT 0/);
    expect(definition).toMatch(/max_attempts\s+TINYINT UNSIGNED NOT NULL DEFAULT 4/);
    expect(definition).toMatch(/recovery_count\s+TINYINT UNSIGNED NOT NULL DEFAULT 0/);
    expect(definition).toMatch(/claim_token\s+CHAR\(36\)\s+NULL/);
    expect(definition).toMatch(/UNIQUE KEY uq_stfd_rule_trap \(organization_id, rule_id, trap_id\)/);
    expect(definition).toMatch(/KEY idx_stfd_due \(status, next_attempt_at\)/);
    expect(definition).toMatch(/max_attempts BETWEEN 1 AND 11 AND attempt_number <= max_attempts/);
    expect(definition).toMatch(/recovery_count <= 1/);
    expect(definition).toMatch(/FOREIGN KEY \(organization_id\)[\s\S]*?REFERENCES organizations \(id\) ON DELETE CASCADE ON UPDATE RESTRICT/);

    const installed = baselineTable('snmp_trap_forwarding_deliveries');
    expect(baselineColumns('snmp_trap_forwarding_deliveries').get('organization_id')).toMatch(/^bigint unsigned NOT NULL/);
    expect(installed).toContain('UNIQUE KEY `uq_stfd_rule_trap` (`organization_id`,`rule_id`,`trap_id`)');
    expect(installed).toMatch(/REFERENCES `organizations` \(`id`\) ON DELETE CASCADE(?! ON UPDATE CASCADE)/);
  });

  test('creates durable global and organization UTC-day quota rows with restart-safe counters', () => {
    const definition = usageDefinition(schema);
    expect(definition).toMatch(/usage_date\s+DATE NOT NULL/);
    expect(definition).toMatch(/scope_type\s+ENUM\('global','organization'\)\s+NOT NULL/);
    expect(definition).toMatch(/scope_id\s+BIGINT UNSIGNED NOT NULL/);
    for (const counter of ['trap_count', 'varbind_bytes', 'delivery_count', 'metadata_only_count', 'dropped_trap_count', 'forwarding_skipped_count']) {
      expect(definition).toMatch(new RegExp(`${counter}\\s+BIGINT UNSIGNED NOT NULL DEFAULT 0`));
      expect(baselineColumns('snmp_trap_ingest_daily_usage').get(counter)).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);
    }
    expect(definition).toMatch(/PRIMARY KEY \(usage_date, scope_type, scope_id\)/);
    expect(definition).toMatch(
      /CHECK \(\s*\(scope_type = 'global' AND scope_id = 0\)\s+OR \(scope_type = 'organization' AND scope_id > 0\)\s*\)/,
    );
    expect(baselineTable('snmp_trap_ingest_daily_usage')).toContain('PRIMARY KEY (`usage_date`,`scope_type`,`scope_id`)');
  });

  test('generic webhook outboxes have durable claim ownership', () => {
    expect(schema).toMatch(/status\s+ENUM\('pending','processing','success','failed','retrying','dead_letter'\)/);
    expect(schema).toMatch(/locked_at\s+DATETIME\s+NULL/);
    expect(schema).toMatch(/claim_token\s+CHAR\(36\)\s+NULL/);
    expect(schema).toMatch(/target_url\s+VARCHAR\(2048\)\s+NULL/);
    expect(schema).toMatch(/recovery_count\s+TINYINT UNSIGNED NOT NULL DEFAULT 0/);
    const columns = baselineColumns('webhook_deliveries');
    for (const column of ['locked_at', 'claim_token', 'target_url', 'recovery_count', 'revoked_at']) {
      expect(columns.has(column)).toBe(true);
    }
    expect(columns.get('status')).toMatch(/'processing'/);
    expect(baselineTable('webhook_deliveries')).toMatch(/KEY `idx_webhook_deliveries_processing`/);
  });

  test('configuration mutation durably revokes processing rows before an A-to-B-to-A edit', () => {
    for (const source of [baselinePrograms, schema]) {
      const trapTrigger = trigger(source, 'trg_stfr_cancel_unclaimed_bu', 'AFTER UPDATE', 'snmp_trap_forwarding_rules');
      expect(trapTrigger).toMatch(/SET revoked_at = COALESCE\(revoked_at, NOW\(\)\)[\s\S]*?status = 'processing'/);
      const webhookTrigger = trigger(source, 'trg_webhooks_cancel_trap_unclaimed_bu', 'AFTER UPDATE', 'webhooks');
      expect(webhookTrigger.match(/SET revoked_at = COALESCE\(revoked_at, NOW\(\)\)/g)).toHaveLength(2);
      expect(webhookTrigger).toMatch(/UPDATE webhook_deliveries[\s\S]*?status = 'processing'/);
    }
  });

  test('fences every queued outbound row with a monotonic organization lifecycle epoch', () => {
    expect(deliveryDefinition(schema)).toMatch(/organization_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 0/);
    expect(schema).toMatch(/webhook_deliveries[\s\S]*?organization_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 0/);
    expect(schema).toMatch(/organizations[\s\S]*?outbound_delivery_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 0/);
    expect(baselineColumns('snmp_trap_forwarding_deliveries').get('organization_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);
    expect(baselineColumns('webhook_deliveries').get('organization_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);
    expect(baselineColumns('organizations').get('outbound_delivery_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);

    for (const source of [baselinePrograms, schema]) {
      const epochTrigger = trigger(source, 'trg_organizations_outbound_epoch_bu', 'BEFORE UPDATE', 'organizations');
      expect(epochTrigger).toMatch(/NEW\.status[\s\S]*?OLD\.status/);
      expect(epochTrigger).toMatch(/NEW\.deleted_at[\s\S]*?OLD\.deleted_at/);
      expect(epochTrigger).toMatch(/SET NEW\.outbound_delivery_epoch = OLD\.outbound_delivery_epoch \+ 1/);

      const cancelTrigger = trigger(source, 'trg_organizations_cancel_outbound_au', 'AFTER UPDATE', 'organizations');
      expect(cancelTrigger).toMatch(/snmp_trap_forwarding_deliveries[\s\S]*?organization_epoch <> NEW\.outbound_delivery_epoch/);
      expect(cancelTrigger).toMatch(/webhook_deliveries[\s\S]*?wd\.organization_epoch <> NEW\.outbound_delivery_epoch/);
      expect(cancelTrigger).toMatch(/status IN \('pending','retrying'\)/);
    }
  });

  test('persists bounded trap-payload truncation metadata without storing discarded values', () => {
    const normalized = schema.replace(/''/g, "'");
    expect(normalized).toMatch(/varbinds_truncated\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/);
    expect(normalized).toMatch(/varbinds_original_count\s+SMALLINT UNSIGNED\s+NOT NULL DEFAULT 0/);
    expect(normalized).toMatch(
      /varbinds_truncation_reason\s+ENUM\('count_limit','size_limit','count_and_size_limit','daily_byte_quota'\)\s+NULL/,
    );
    const traps = baselineColumns('snmp_traps');
    expect(traps.get('varbinds_truncated')).toMatch(/^tinyint\(1\) NOT NULL DEFAULT '0'/);
    expect(traps.get('varbinds_original_count')).toMatch(/^smallint unsigned NOT NULL DEFAULT '0'/);
    expect(traps.get('varbinds_truncation_reason')).toMatch(/^enum\('count_limit','size_limit','count_and_size_limit','daily_byte_quota'\) .*DEFAULT NULL/);
  });

  test('links outcomes to their rule, stored trap, and selected webhook', () => {
    const definition = deliveryDefinition(schema);
    expect(definition).toMatch(/FOREIGN KEY \(rule_id\)[\s\S]*?REFERENCES snmp_trap_forwarding_rules \(id\)/);
    expect(definition).toMatch(/FOREIGN KEY \(trap_id\)[\s\S]*?REFERENCES snmp_traps \(id\)/);
    expect(definition).toMatch(/FOREIGN KEY \(webhook_id\)[\s\S]*?REFERENCES webhooks \(id\)/);
    const installed = baselineTable('snmp_trap_forwarding_deliveries');
    expect(installed).toMatch(/FOREIGN KEY \(`rule_id`\) REFERENCES `snmp_trap_forwarding_rules`/);
    expect(installed).toMatch(/FOREIGN KEY \(`trap_id`\) REFERENCES `snmp_traps`/);
    expect(installed).toMatch(/FOREIGN KEY \(`webhook_id`\) REFERENCES `webhooks`/);
  });

  test('documents and preserves the outbound payload privacy boundary', () => {
    expect(baselineColumns('snmp_trap_forwarding_deliveries').get('payload'))
      .toMatch(/^json NOT NULL .*never community\/credentials\/varbind values/i);
    expect(schema).toMatch(/snmp_trap_forwarding_deliveries[^\n]*[\s\S]{0,300}Payload contains allowlisted metadata only/i);
  });

  test('exposes only summarized outcome fields on rules', () => {
    const normalized = schema.replace(/''/g, "'");
    expect(normalized).toMatch(/last_delivery_status\s+ENUM\('pending','processing','retrying','success','dead_letter','cancelled'\)/);
    expect(normalized).toMatch(/last_delivery_at\s+DATETIME\s+NULL/);
    expect(normalized).toMatch(/last_error\s+VARCHAR\(500\)\s+NULL/);
    expect(normalized).toMatch(/last_delivery_is_test\s+TINYINT\(1\)\s+NOT NULL DEFAULT 0/);
    const rules = baselineColumns('snmp_trap_forwarding_rules');
    expect(rules.get('last_delivery_status')).toMatch(/^enum\('pending','processing','retrying','success','dead_letter','cancelled'\)/);
    expect(rules.get('last_delivery_is_test')).toMatch(/^tinyint\(1\) NOT NULL DEFAULT '0'/);
  });

  test('seeds full trap-payload access only for admin and super_admin roles', () => {
    const roles = new Map(baselineRows('roles').map(r => [r.id, r.name]));
    const permission = baselineRows('permissions').find(p => p.name === 'snmp_traps.payload.view');
    expect(permission).toBeDefined();
    const holders = baselineRows('role_permissions')
      .filter(rp => rp.permission_id === permission.id).map(rp => roles.get(rp.role_id));
    expect(holders).toContain('admin');
    for (const role of holders) expect(['admin', 'super_admin']).toContain(role);

    const permissionAt = schema.indexOf('snmp_traps.payload.view');
    expect(permissionAt).toBeGreaterThan(-1);
    const permissionSeed = schema.slice(permissionAt, permissionAt + 1800);
    expect(permissionSeed).toMatch(/INSERT IGNORE INTO role_permissions/);
    expect(permissionSeed).toMatch(/WHERE r\.name IN \('admin',\s*'super_admin'\)/);
    expect(permissionSeed).not.toMatch(/WHERE r\.name IN \([^)]*(?:technician|readonly|support|billing)/);
  });
});
