'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ClientBalanceLedger = require('../src/models/ClientBalanceLedger');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const FILENAME = '465_reverse_draft_credit_note_ledger_credits.sql';
const statements = read(`database/migrations/${FILENAME}`).replace(/--.*$/gm, '');
const squash = s => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

describe('migration 465 draft credit-note ledger reversal', () => {
  test('is one append-only INSERT ... SELECT: no history is updated or deleted, no DDL', () => {
    expect(statements.match(/\bINSERT INTO\b/g)).toHaveLength(1);
    expect(statements).toMatch(/INSERT INTO client_balance_ledger\s*\(\s*client_id, organization_id, entry_type, amount, currency,\s*reference_type, reference_id, description\)\s*SELECT/);
    expect(statements).not.toMatch(/\b(?:UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|RENAME)\b/i);
  });

  test('targets only drafts and references the note exactly like the original credit', () => {
    expect(statements).toMatch(/WHERE cn\.status = 'draft'/);
    expect(statements).toMatch(/'debit',\s*-posted\.net,/);
    expect(statements).toMatch(/'credit_note',\s*cn\.id,/);
    expect(statements).toMatch(/WHERE l\.reference_type = 'credit_note'/);
    expect(statements).toMatch(/posted\.reference_id = cn\.id\s+AND posted\.client_id = cn\.client_id\s+AND posted\.organization_id <=> cn\.organization_id/);
    // Soft-deleted drafts are reversed too (a restore + issue must not double-post).
    expect(statements).not.toMatch(/deleted_at/);
  });

  test('is idempotent: it only reverses a non-zero NET credit, so a rerun inserts nothing', () => {
    expect(statements).toMatch(/AND posted\.net < -0\.005;/);
    expect(statements).toMatch(/GROUP BY l\.reference_id, l\.client_id, l\.organization_id/);
  });

  test('nets with the same signed expression as ClientBalanceLedger.signedAmountSql', () => {
    const inMigration = statements.match(/SUM\(([\s\S]*?)\) AS net/)[1].replace(/\bl\./g, '');
    expect(squash(inMigration).replace(/, /g, ',')).toBe(squash(ClientBalanceLedger.signedAmountSql).replace(/, /g, ','));
  });

  test('ships an identically named rollback that preserves the reversals', () => {
    const rollback = read(`database/rollbacks/${FILENAME}`);
    expect(rollback).toMatch(/NOT removed/);
    const exec = rollback.replace(/--.*$/gm, '');
    expect(exec).toMatch(/SELECT 1 AS draft_credit_note_ledger_reversal_preserved/);
    expect(exec).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i);
  });

  test('README documents migration 465 and its range covers it', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/> \*\*Migration 465 — /);
    const line = readme.split('\n').find(l => l.includes('Individual numbered migration files'));
    expect(Number(line.replace(/\)/g, '').match(/(\d+)\s*$/)[1])).toBeGreaterThanOrEqual(465);
  });
});
