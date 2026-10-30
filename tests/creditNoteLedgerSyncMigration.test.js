'use strict';

// Static contract for migration 466 (no live database in plain Jest): it must
// append-only bring every credit note's net ledger credit to the runtime
// invariant in src/services/creditNoteLedgerService.js, and be rerun-safe.

const fs = require('node:fs');
const path = require('node:path');
const ClientBalanceLedger = require('../src/models/ClientBalanceLedger');
const { ledgerTarget, POSTED_STATUSES } = require('../src/services/creditNoteLedgerService');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const FILENAME = '466_sync_credit_note_ledger_to_status.sql';
const statements = read(`database/migrations/${FILENAME}`).replace(/--.*$/gm, '');
const squash = s => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

describe('migration 466 credit-note ledger sync', () => {
  test('is one append-only INSERT ... SELECT: no history is updated or deleted, no DDL', () => {
    expect(statements.match(/\bINSERT INTO\b/g)).toHaveLength(1);
    expect(statements).toMatch(/INSERT INTO client_balance_ledger\s*\(\s*client_id, organization_id, entry_type, amount, currency,\s*reference_type, reference_id, description\)\s*SELECT/);
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|RENAME)\b/i);
  });

  test('references the note exactly like every credit-note ledger row', () => {
    expect(statements).toMatch(/'credit_note',\s*gap\.id,/);
    expect(statements).toMatch(/WHERE l\.reference_type = 'credit_note'/);
    expect(statements).toMatch(/posted\.reference_id = cn\.id\s+AND posted\.client_id = cn\.client_id\s+AND posted\.organization_id <=> cn\.organization_id/);
    // Notes with no ledger rows at all (old refund-path notes) must be reached.
    expect(statements).toMatch(/LEFT JOIN \(/);
    expect(statements).toMatch(/WHERE cn\.client_id IS NOT NULL/);
  });

  test('targets the same statuses as the runtime invariant, soft-deleted notes at zero', () => {
    const targets = statements.match(/CASE WHEN cn\.status IN \(([^)]*)\) AND cn\.deleted_at IS NULL/g);
    expect(targets).toHaveLength(2);
    const statuses = targets[0].match(/IN \(([^)]*)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''));
    expect(new Set(statuses)).toEqual(POSTED_STATUSES);
    // Runtime twin of the CASE: posted & live -> total, everything else -> 0.
    expect(ledgerTarget({ status: 'issued', total: '10.00', deleted_at: null })).toBe(10);
    expect(ledgerTarget({ status: 'applied', total: '10.00', deleted_at: null })).toBe(10);
    expect(ledgerTarget({ status: 'issued', total: '10.00', deleted_at: '2026-01-01' })).toBe(0);
    for (const status of ['draft', 'cancelled']) {
      expect(ledgerTarget({ status, total: '10.00', deleted_at: null })).toBe(0);
    }
  });

  test('posts the difference in the right direction: credit to top up, debit to reverse', () => {
    // diff = target - credited = target + signed net (signed is positive for debits).
    expect(statements).toMatch(/THEN cn\.total ELSE 0 END\)\s*\+ COALESCE\(posted\.net, 0\), 2\) AS diff/);
    expect(statements).toMatch(/CASE WHEN gap\.diff > 0 THEN 'credit' ELSE 'debit' END,\s*ABS\(gap\.diff\),/);
  });

  test('is idempotent: it only inserts where the net differs from the target', () => {
    expect(statements).toMatch(/WHERE ABS\(gap\.diff\) >= 0\.005;/);
    expect(statements).toMatch(/GROUP BY l\.reference_id, l\.client_id, l\.organization_id/);
  });

  test('nets with the same signed expression as ClientBalanceLedger.signedAmountSql', () => {
    const inMigration = statements.match(/SUM\(([\s\S]*?)\) AS net/)[1].replace(/\bl\./g, '');
    expect(squash(inMigration).replace(/, /g, ',')).toBe(squash(ClientBalanceLedger.signedAmountSql).replace(/, /g, ','));
  });

  test('ships an identically named rollback that preserves the rows', () => {
    const rollback = read(`database/rollbacks/${FILENAME}`);
    expect(rollback).toMatch(/NOT removed/);
    const exec = rollback.replace(/--.*$/gm, '');
    expect(exec).toMatch(/SELECT 1 AS credit_note_ledger_sync_preserved/);
    expect(exec).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i);
  });

  test('README documents migration 466 and its range covers it', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/> \*\*Migration 466 — /);
    const line = readme.split('\n').find(l => l.includes('Individual numbered migration files'));
    expect(Number(line.replace(/\)/g, '').match(/(\d+)\s*$/)[1])).toBeGreaterThanOrEqual(466);
  });
});
