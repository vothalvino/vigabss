// =============================================================================
// Migration 006: sealing a cash bag takes its cash off the reseller's ledger
// =============================================================================
// The seal posts a 'bag_sealed' line of -declared (services/cashBagService.js);
// the migration adds the ENUM value and backfills the line for every bag that
// migration 005 sealed without one. No database runs here (plain Jest): these
// read the SQL for the guards that make a re-run insert nothing, and check the
// money figures of resellerLedgerService.summarize. tests/cashBags.test.js
// covers the seal, receipt and loss end to end against the in-memory fake.
// =============================================================================

const fs = require('fs');
const path = require('path');
const ledger = require('../src/services/resellerLedgerService');

const FILE = '006_reseller_bag_sealed_ledger.sql';
const read = (dir) => fs.readFileSync(path.join(__dirname, '..', 'database', dir, FILE), 'utf8');
const sqlOnly = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
const migration = sqlOnly(read('migrations'));
const rollback = sqlOnly(read('rollbacks'));
const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');

describe('migration 006', () => {
  test('is the latest migration, with a rollback of the same name', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'database', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe(FILE);
    expect(fs.existsSync(path.join(__dirname, '..', 'database', 'rollbacks', FILE))).toBe(true);
  });

  test('adds bag_sealed to entry_type only when it is missing, keeping the other four values', () => {
    expect(migration).toMatch(/COLUMN_NAME = 'entry_type' AND COLUMN_TYPE NOT LIKE '%''bag_sealed''%' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type ENUM\('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed'\) NOT NULL/);
    expect(migration).toMatch(/DROP PROCEDURE IF EXISTS m006_bag_sealed_entry_type; DELIMITER \$\$ CREATE PROCEDURE m006_bag_sealed_entry_type\(\)/);
  });

  test('schema.sql has the same ENUM', () => {
    const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS reseller_ledger_entries'));
    expect(table.slice(0, table.indexOf(';'))).toMatch(/entry_type\s+ENUM\('collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed'\) NOT NULL/);
  });

  describe('the backfill', () => {
    const insert = migration.slice(migration.indexOf('INSERT INTO reseller_ledger_entries'));
    const statement = insert.slice(0, insert.indexOf(';'));

    test('posts -declared as bag_sealed on the bag and its reseller, dated and signed by the seal', () => {
      expect(statement).toMatch(/\(organization_id, reseller_id, entry_type, amount, currency, payment_id, cash_session_id, note, created_by, created_at, cash_bag_id\)/);
      expect(statement).toMatch(/SELECT b\.organization_id, b\.reseller_id, 'bag_sealed', -b\.declared_amount, b\.currency, NULL, NULL, CONCAT\('Bolsa ', b\.serial, ' sellada'\), COALESCE\(us\.id, uc\.id\), COALESCE\(b\.sealed_at, b\.updated_at\), b\.id FROM cash_bags b/);
      // The sealing user, else the one that registered the bag; never a user
      // id that this database does not hold (created_by has a foreign key).
      expect(statement).toMatch(/LEFT JOIN users us ON us\.id = b\.sealed_by LEFT JOIN users uc ON uc\.id = b\.created_by/);
      expect(statement).toMatch(/AND COALESCE\(us\.id, uc\.id\) IS NOT NULL$/);
    });

    test('reaches only the bags still sealed or travelling, with a reseller and money in them', () => {
      expect(statement).toMatch(/AND b\.status IN \('ready_for_pickup', 'in_transit'\)/);
      expect(statement).toMatch(/AND b\.deleted_at IS NULL AND b\.reseller_id IS NOT NULL AND b\.declared_amount IS NOT NULL AND b\.declared_amount > 0/);
      // Received bags already have their deposit, and lost ones keep the old rule.
      expect(statement).not.toMatch(/'received'|'lost'/);
    });

    test('a re-run inserts nothing: only bags without a bag_sealed line of their own', () => {
      expect(statement).toMatch(/WHERE NOT EXISTS \( SELECT 1 FROM reseller_ledger_entries e WHERE e\.cash_bag_id = b\.id AND e\.entry_type = 'bag_sealed' \)/);
    });

    test('is plain SQL, so it runs on each database the migration runs on (primary and isolated tenants)', () => {
      expect(statement).not.toMatch(/organization_id = \d/);
      expect(statement).not.toMatch(/\b[a-z_]+\.(cash_bags|reseller_ledger_entries)\b/);
    });
  });
});

describe('rollback 006', () => {
  test('rewrites the bag_sealed lines in one transaction, before the ENUM loses the value', () => {
    const data = rollback.slice(rollback.indexOf('CREATE PROCEDURE r006_bag_sealed_lines'), rollback.indexOf('CALL r006_bag_sealed_lines'));
    expect(data).toMatch(/DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;/);
    expect(data).toMatch(/START TRANSACTION;[\s\S]*COMMIT;/);
    expect(rollback.indexOf('CALL r006_bag_sealed_lines')).toBeLessThan(rollback.indexOf('CALL r006_entry_type'));
    expect(rollback).not.toMatch(/DELETE FROM reseller_ledger_entries|DROP TABLE/);
  });

  test('a bag still sealed or travelling gets a compensating +declared adjustment, as the 005 code counts it in_bags', () => {
    expect(rollback).toMatch(/SELECT e\.organization_id, e\.reseller_id, 'adjustment', -e\.amount, e\.currency, NULL, NULL, CONCAT\('Rollback 006: bolsa ', b\.serial, ' vuelve a contar como en bolsas'\), e\.created_by, e\.cash_bag_id FROM reseller_ledger_entries e JOIN cash_bags b ON b\.id = e\.cash_bag_id WHERE e\.entry_type = 'bag_sealed' AND b\.status IN \('ready_for_pickup', 'in_transit'\);/);
  });

  test('a received bag gets the deposit the 005 receipt posts, and every other line becomes an adjustment', () => {
    expect(rollback).toMatch(/SET e\.entry_type = 'deposit' WHERE e\.entry_type = 'bag_sealed' AND b\.status = 'received';/);
    expect(rollback).toMatch(/UPDATE reseller_ledger_entries SET entry_type = 'adjustment' WHERE entry_type = 'bag_sealed';/);
  });

  test('restores the four 005 values, guarded so a re-run does nothing', () => {
    expect(rollback).toMatch(/COLUMN_TYPE LIKE '%''bag_sealed''%' \) THEN ALTER TABLE reseller_ledger_entries MODIFY COLUMN entry_type ENUM\('collection', 'collection_void', 'deposit', 'adjustment'\) NOT NULL/);
  });
});

describe('the money figures (resellerLedgerService.summarize)', () => {
  test('cash on hand is the balance; in_bags is reported and subtracted nowhere', () => {
    expect(ledger.summarize('300.00', '1000.00', '500.00')).toEqual({
      balance: 300, in_bags: 500, cash_on_hand: 300, credit_limit: 1000, available_to_collect: 700,
    });
  });

  test('available_to_collect never goes below 0', () => {
    expect(ledger.summarize('1200.00', '1000.00', 0)).toMatchObject({ cash_on_hand: 1200, available_to_collect: 0 });
    expect(ledger.summarize(0, 0, '50.00')).toEqual({ balance: 0, in_bags: 50, cash_on_hand: 0, credit_limit: 0, available_to_collect: 0 });
  });

  test('bag_sealed is a ledger type staff cannot post by hand', () => {
    expect(ledger.ENTRY_TYPES).toContain('bag_sealed');
    expect(ledger.MANUAL_ENTRY_TYPES).toEqual(['deposit', 'adjustment']);
  });
});
