// =============================================================================
// Migration 007: the reseller commission engine (reseller program, phase 4)
// =============================================================================
// No database runs here (plain Jest): these read the SQL for the guards that
// make a re-run do nothing, the go-live setting, schema.sql parity and the
// rollback's refusal while commission money exists. CI's migrate:smoke-test
// and rollback jobs run it against MySQL 8 and MariaDB 10.6.
// tests/resellerCommissions.test.js covers the engine.
// =============================================================================

const fs = require('fs');
const path = require('path');

const FILE = '007_reseller_commissions.sql';
const read = (dir) => fs.readFileSync(path.join(__dirname, '..', 'database', dir, FILE), 'utf8');
const sqlOnly = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
const migration = sqlOnly(read('migrations'));
const rollback = sqlOnly(read('rollbacks'));
const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
const tableOf = (name) => {
  const t = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`));
  return t.slice(0, t.indexOf(') ENGINE='));
};

describe('migration 007', () => {
  test('exists, with a rollback of the same name', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'database', 'migrations', FILE))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '..', 'database', 'rollbacks', FILE))).toBe(true);
  });

  test('every DDL statement is guarded by information_schema, and routines are dropped first', () => {
    const alters = migration.match(/ALTER TABLE [^;]+;/g) || [];
    expect(alters.length).toBeGreaterThan(10);
    for (const proc of ['m007_reseller_commissions', 'm007_reseller_ledger']) {
      expect(migration).toMatch(new RegExp(`DROP PROCEDURE IF EXISTS ${proc}; DELIMITER \\$\\$ CREATE PROCEDURE ${proc}\\(\\)`));
      expect(migration).toMatch(new RegExp(`CALL ${proc}\\(\\); DROP PROCEDURE IF EXISTS ${proc};`));
    }
    // Each ALTER sits inside an IF on information_schema.
    const ifs = migration.match(/IF (NOT )?EXISTS \( SELECT 1 FROM information_schema\./g) || [];
    expect(ifs.length).toBeGreaterThanOrEqual(alters.length - 1);
  });

  test('reseller_commissions: organization_id backfilled from the reseller, else the invoice, then NOT NULL (refusing an orphan)', () => {
    expect(migration).toMatch(/ALTER TABLE reseller_commissions ADD COLUMN organization_id BIGINT UNSIGNED NULL DEFAULT NULL/);
    expect(migration).toMatch(/UPDATE reseller_commissions rc JOIN resellers r ON r\.id = rc\.reseller_id SET rc\.organization_id = r\.organization_id WHERE rc\.organization_id IS NULL AND r\.organization_id IS NOT NULL;/);
    expect(migration).toMatch(/UPDATE reseller_commissions rc JOIN invoices i ON i\.id = rc\.invoice_id SET rc\.organization_id = i\.organization_id WHERE rc\.organization_id IS NULL AND i\.organization_id IS NOT NULL;/);
    expect(migration).toMatch(/IS_NULLABLE = 'YES' \) THEN IF EXISTS \(SELECT 1 FROM reseller_commissions WHERE organization_id IS NULL LIMIT 1\) THEN SIGNAL SQLSTATE '45000'/);
    expect(migration).toMatch(/MODIFY COLUMN organization_id BIGINT UNSIGNED NOT NULL/);
    expect(migration).toMatch(/ADD CONSTRAINT fk_rc_organization FOREIGN KEY \(organization_id\) REFERENCES organizations \(id\) ON DELETE RESTRICT/);
  });

  test('reseller_commissions gains base_amount, earned_at, reversed_at and the earned/reversed status, mapping old rows', () => {
    for (const col of ['base_amount DECIMAL\\(12, 2\\) NULL', 'earned_at TIMESTAMP NULL', 'reversed_at TIMESTAMP NULL']) {
      expect(migration).toMatch(new RegExp(`ADD COLUMN ${col}`));
    }
    // Widen, map, then narrow: a re-run after either step finishes the job.
    expect(migration).toMatch(/COLUMN_TYPE NOT LIKE '%''earned''%' \) THEN ALTER TABLE reseller_commissions MODIFY COLUMN status ENUM\('pending', 'approved', 'paid', 'cancelled', 'earned', 'reversed'\)/);
    expect(migration).toMatch(/COLUMN_TYPE LIKE '%''pending''%' \) THEN UPDATE reseller_commissions SET status = 'reversed', reversed_at = COALESCE\(reversed_at, updated_at\) WHERE status = 'cancelled'; UPDATE reseller_commissions SET status = 'earned', earned_at = COALESCE\(earned_at, created_at\) WHERE status IN \('pending', 'approved', 'paid'\); ALTER TABLE reseller_commissions MODIFY COLUMN status ENUM\('earned', 'reversed'\) NOT NULL DEFAULT 'earned'/);
    // One commission per (reseller, invoice) stays the unique key.
    expect(tableOf('reseller_commissions')).toMatch(/UNIQUE KEY uq_reseller_commissions \(reseller_id, invoice_id\)/);
  });

  test('reseller_ledger_entries gains the three types, the invoice and commission links, and a nullable created_by', () => {
    expect(migration).toMatch(/COLUMN_TYPE NOT LIKE '%''payout''%' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type ENUM\('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout'\) NOT NULL/);
    expect(migration).toMatch(/COLUMN_NAME = 'created_by' AND IS_NULLABLE = 'NO' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN created_by BIGINT UNSIGNED NULL DEFAULT NULL/);
    expect(migration).toMatch(/ADD COLUMN invoice_id BIGINT UNSIGNED NULL DEFAULT NULL/);
    expect(migration).toMatch(/ADD COLUMN commission_id BIGINT UNSIGNED NULL DEFAULT NULL/);
    expect(migration).toMatch(/ADD KEY idx_reseller_ledger_invoice \(invoice_id\)/);
    expect(migration).toMatch(/ADD KEY idx_reseller_ledger_commission \(commission_id\)/);
    expect(migration).toMatch(/ADD CONSTRAINT fk_reseller_ledger_invoice FOREIGN KEY \(invoice_id\) REFERENCES invoices \(id\) ON DELETE RESTRICT/);
    expect(migration).toMatch(/ADD CONSTRAINT fk_reseller_ledger_commission FOREIGN KEY \(commission_id\) REFERENCES reseller_commissions \(id\) ON DELETE RESTRICT/);
  });

  test('the go-live point is written once per organization (INSERT IGNORE), in UTC', () => {
    expect(migration).toMatch(/INSERT IGNORE INTO organization_settings \(organization_id, setting_key, setting_value\) SELECT o\.id, 'reseller_commissions_since', DATE_FORMAT\(UTC_TIMESTAMP\(\), '%Y-%m-%d %H:%i:%s'\) FROM organizations o;/);
    // Not in the settings catalog: no route shows or edits it.
    const { ORG_SETTING_DEFS } = require('../src/services/settingsCatalog');
    expect(ORG_SETTING_DEFS.reseller_commissions_since).toBeUndefined();
    expect(require('../src/services/resellerCommissionService').COMMISSIONS_SINCE_KEY).toBe('reseller_commissions_since');
  });

  test('is plain SQL, so it runs on each database the migration runs on (primary and isolated tenants)', () => {
    expect(migration).not.toMatch(/organization_id = \d/);
    expect(migration).not.toMatch(/\b[a-z_]+\.(reseller_commissions|reseller_ledger_entries)\b/);
  });

  test('schema.sql has the final structure', () => {
    const rc = tableOf('reseller_commissions');
    expect(rc).toMatch(/organization_id BIGINT UNSIGNED NOT NULL/);
    expect(rc).toMatch(/base_amount\s+DECIMAL\(12, 2\)\s+NULL/);
    expect(rc).toMatch(/status\s+ENUM\('earned', 'reversed'\) NOT NULL DEFAULT 'earned'/);
    expect(rc).toMatch(/earned_at\s+TIMESTAMP\s+NULL/);
    expect(rc).toMatch(/reversed_at\s+TIMESTAMP\s+NULL/);
    expect(rc).toMatch(/KEY idx_reseller_commissions_org_reseller_earned \(organization_id, reseller_id, earned_at\)/);
    expect(rc).toMatch(/CONSTRAINT fk_rc_organization FOREIGN KEY \(organization_id\)\s+REFERENCES organizations \(id\) ON DELETE RESTRICT/);
    const le = tableOf('reseller_ledger_entries');
    // Migration 011 appended the collection fee types after payout.
    expect(le).toMatch(/entry_type\s+ENUM\('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed', 'commission', 'commission_reversal', 'payout'(?:, 'collection_fee', 'collection_fee_reversal')?\) NOT NULL/);
    expect(le).toMatch(/created_by\s+BIGINT UNSIGNED NULL\s+DEFAULT NULL/);
    expect(le).toMatch(/invoice_id\s+BIGINT UNSIGNED NULL/);
    expect(le).toMatch(/commission_id\s+BIGINT UNSIGNED NULL/);
    expect(le).toMatch(/CONSTRAINT fk_reseller_ledger_invoice FOREIGN KEY \(invoice_id\)\s+REFERENCES invoices \(id\) ON DELETE RESTRICT/);
    expect(le).toMatch(/CONSTRAINT fk_reseller_ledger_commission FOREIGN KEY \(commission_id\)\s+REFERENCES reseller_commissions \(id\) ON DELETE RESTRICT/);
  });

  test('the ledger service knows the types, and staff may post only deposit, adjustment and payout', () => {
    const ledger = require('../src/services/resellerLedgerService');
    expect(ledger.ENTRY_TYPES).toEqual(expect.arrayContaining(['commission', 'commission_reversal', 'payout']));
    expect(ledger.MANUAL_ENTRY_TYPES).toEqual(['deposit', 'adjustment', 'payout']);
  });
});

describe('rollback 007', () => {
  test('refuses, before anything else, while commission or payout lines or engine commissions exist', () => {
    const refusal = rollback.indexOf("SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rollback 007 refused: the reseller ledger holds commission or payout lines'");
    expect(refusal).toBeGreaterThan(-1);
    expect(rollback).toMatch(/WHERE entry_type IN \('commission', 'commission_reversal', 'payout'\) LIMIT 1/);
    expect(rollback).toMatch(/IF EXISTS \(SELECT 1 FROM reseller_commissions WHERE base_amount IS NOT NULL LIMIT 1\) THEN SIGNAL SQLSTATE '45000'/);
    const firstChange = Math.min(...['DELETE FROM', 'ALTER TABLE', 'UPDATE reseller_commissions'].map((k) => rollback.indexOf(k)).filter((i) => i >= 0));
    expect(refusal).toBeLessThan(firstChange);
    expect(rollback.indexOf('CALL r007_refuse_with_commissions')).toBeLessThan(firstChange);
    expect(rollback).not.toMatch(/DELETE FROM reseller_ledger_entries|DELETE FROM reseller_commissions|DROP TABLE/);
  });

  test('undoes every structural change, guarded so a re-run does nothing', () => {
    for (const [table, col] of [
      ['reseller_ledger_entries', 'commission_id'], ['reseller_ledger_entries', 'invoice_id'],
      ['reseller_commissions', 'reversed_at'], ['reseller_commissions', 'earned_at'],
      ['reseller_commissions', 'base_amount'], ['reseller_commissions', 'organization_id'],
    ]) {
      expect(rollback).toMatch(new RegExp(`TABLE_NAME = '${table}' AND COLUMN_NAME = '${col}' \\) THEN ALTER TABLE ${table} DROP COLUMN ${col};`));
    }
    expect(rollback).toMatch(/ALTER TABLE reseller_ledger_entries DROP FOREIGN KEY fk_reseller_ledger_commission;/);
    expect(rollback).toMatch(/ALTER TABLE reseller_ledger_entries DROP FOREIGN KEY fk_reseller_ledger_invoice;/);
    expect(rollback).toMatch(/ALTER TABLE reseller_commissions DROP FOREIGN KEY fk_rc_organization;/);
    expect(rollback).toMatch(/COLUMN_TYPE LIKE '%''payout''%' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type ENUM\('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed'\) NOT NULL/);
    expect(rollback).toMatch(/IS_NULLABLE = 'YES' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN created_by BIGINT UNSIGNED NOT NULL/);
    expect(rollback).toMatch(/UPDATE reseller_commissions SET status = 'pending' WHERE status = 'earned'; UPDATE reseller_commissions SET status = 'cancelled' WHERE status = 'reversed'; ALTER TABLE reseller_commissions MODIFY COLUMN status ENUM\('pending', 'approved', 'paid', 'cancelled'\) NOT NULL DEFAULT 'pending';/);
    expect(rollback).toMatch(/DELETE FROM organization_settings WHERE setting_key = 'reseller_commissions_since';/);
  });
});
