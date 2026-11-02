// =============================================================================
// DB-14 — evidence-destroying rollbacks fail closed
// =============================================================================
// Rollback 447 dropped signed_documents without a word, and rollback 451
// dropped evidence hashes and consent provenance. Both now refuse, before any
// destructive statement, while that evidence exists (as rollback 452 does).

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '../database/rollbacks', f), 'utf8');

function preflightRunsFirst(sql, procedure) {
  const call = sql.indexOf(`CALL ${procedure}();`);
  const firstDestructive = sql.search(/\b(DROP TABLE|DROP COLUMN|DELETE FROM|DELETE rp|MODIFY COLUMN|UPDATE signed_documents)\b/);
  expect(call).toBeGreaterThan(-1);
  expect(call).toBeLessThan(firstDestructive);
}

test('rollback 447 refuses while any signed document exists', () => {
  const sql = read('447_legal_document_signing.sql');
  expect(sql).toMatch(/DESTRUCTIVE/);
  expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM signed_documents LIMIT 1\) THEN\s+SIGNAL SQLSTATE '45000'/);
  preflightRunsFirst(sql, 'rollback_447_legal_document_signing_preflight');
});

test.each([
  ['signed_documents', 'evidence_sha256'], ['signed_documents', 'captured_by'], ['signed_documents', 'communication_choices'],
  ['subscriber_consents', 'captured_by'], ['subscriber_consents', 'signed_document_id'], ['subscriber_consents', 'source_context'],
])('rollback 451 refuses while %s.%s is populated', (table, column) => {
  const sql = read('451_installation_consent_and_global_acknowledgment.sql');
  expect(sql).toContain(`TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`);
  expect(sql).toContain(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`);
  preflightRunsFirst(sql, 'rollback_451_installation_consent_preflight');
});
