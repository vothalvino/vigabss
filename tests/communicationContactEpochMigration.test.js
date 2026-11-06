'use strict';
// =============================================================================
// Client communication-contact epoch (introduced by development migration 460)
// =============================================================================
// An email or phone change, a deletion or an inactive boundary moves the
// client's contact epoch, which fences consent and queued deliveries captured
// under the old destination. Checked in the baseline (what installs get) and
// in schema.sql. The one-off data repairs 460 ran on existing rows (SMTP
// credential scrub, queue terminalization, consent withdrawal) went with the
// development history; a new install has no such rows.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineColumns, baselineProgram } = require('./helpers/baseline');

const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');
const baselineTrigger = baselineProgram('trigger', 'trg_clients_communication_contact_epoch_bu');

function schemaTrigger() {
  const trigger = schema.match(
    /CREATE TRIGGER trg_clients_communication_contact_epoch_bu[\s\S]*?BEFORE UPDATE ON clients[\s\S]*?END\$\$/,
  );
  expect(trigger).toBeDefined();
  return trigger[0];
}

describe('client communication-contact epoch', () => {
  test('adds fail-closed epoch defaults to the baseline and canonical schema', () => {
    expect(baselineColumns('clients').get('email_contact_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '1'.*email identity/i);
    expect(baselineColumns('clients').get('phone_contact_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '1'.*phone identity/i);
    expect(baselineColumns('subscriber_consents').get('communication_contact_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'.*consent/i);

    expect(schema).toMatch(/email_contact_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 1[\s\S]*?email identity/i);
    expect(schema).toMatch(/phone_contact_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 1[\s\S]*?phone identity/i);
    expect(schema).toMatch(/communication_contact_epoch\s+BIGINT UNSIGNED\s+NOT NULL DEFAULT 0[\s\S]*?consent/i);
  });

  test('increments only the byte-distinct or NULL-distinct destination epoch', () => {
    for (const trigger of [baselineTrigger, schemaTrigger()]) {
      expect(trigger).toMatch(/NOT \(BINARY NEW\.email <=> BINARY OLD\.email\)/);
      expect(trigger).toMatch(/NOT \(BINARY NEW\.phone <=> BINARY OLD\.phone\)/);
      expect(trigger.match(/NOT \(NEW\.deleted_at <=> OLD\.deleted_at\)/g)).toHaveLength(2);
      expect(trigger.match(/\(\(NEW\.status = 'inactive'\) <> \(OLD\.status = 'inactive'\)\)/g))
        .toHaveLength(2);
      expect(trigger).toMatch(
        /NEW\.email[\s\S]*?OR NOT \(NEW\.deleted_at <=> OLD\.deleted_at\)[\s\S]*?SET NEW\.email_contact_epoch = OLD\.email_contact_epoch \+ 1[\s\S]*?ELSE\s+SET NEW\.email_contact_epoch = OLD\.email_contact_epoch/,
      );
      expect(trigger).toMatch(
        /NEW\.phone[\s\S]*?OR NOT \(NEW\.deleted_at <=> OLD\.deleted_at\)[\s\S]*?SET NEW\.phone_contact_epoch = OLD\.phone_contact_epoch \+ 1[\s\S]*?ELSE\s+SET NEW\.phone_contact_epoch = OLD\.phone_contact_epoch/,
      );
    }
  });

  test('inactive boundary fences both channels while active-to-suspended alone does not', () => {
    for (const trigger of [baselineTrigger, schemaTrigger()]) {
      expect(trigger.match(/\(\(NEW\.status = 'inactive'\) <> \(OLD\.status = 'inactive'\)\)/g) || []).toHaveLength(2);
      expect(trigger).not.toMatch(/NOT \(NEW\.status <=> OLD\.status\)/);
      expect(trigger).not.toMatch(/NEW\.status <> OLD\.status/);
    }
  });

  test('persists a server-owned delivery class with no default, so unclassified work fails closed', () => {
    for (const table of ['email_logs', 'sms_logs']) {
      expect(baselineColumns(table).get('message_class'))
        .toMatch(/^enum\('marketing','transactional','security','support_reply'\) .*DEFAULT NULL .*fails closed/i);
    }
    const logTables = ['email_logs', 'sms_logs'].map((table) => {
      const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      return schema.slice(start, schema.indexOf(') ENGINE', start));
    }).join('\n');
    expect(logTables.match(/message_class\s+ENUM\('marketing','transactional','security','support_reply'\)\s+NULL/g) || [])
      .toHaveLength(2);
  });

  test('SMS refusal codes fit stable policy codes', () => {
    expect(baselineColumns('sms_logs').get('error_code')).toMatch(/^varchar\(64\) .*Provider or stable application refusal code/);
    expect(schema).toMatch(/error_code\s+VARCHAR\(64\)\s+NULL[\s\S]*?Provider or stable application refusal code/);
  });

  test('snapshots the organization and client contact epochs on every durable client-delivery queue', () => {
    for (const table of ['email_logs', 'sms_logs', 'campaign_messages']) {
      expect(baselineColumns(table).get('organization_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);
      expect(baselineColumns(table).get('client_contact_epoch')).toMatch(/^bigint unsigned NOT NULL DEFAULT '0'/);
      expect(schema.replace(/''/g, "'")).toMatch(
        new RegExp(`${table}[\\s\\S]*?client_contact_epoch\\s+BIGINT UNSIGNED\\s+NOT NULL DEFAULT 0`),
      );
    }
  });
});
