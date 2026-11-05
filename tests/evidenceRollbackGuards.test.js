// =============================================================================
// DB-14 — evidence-destroying rollbacks fail closed
// =============================================================================
// A development rollback once dropped signed_documents without a word, and
// another dropped evidence hashes and consent provenance. The baseline has no
// rollback at all, so that history cannot be undone; every later rollback that
// drops or deletes evidence must refuse first, before its first destructive
// statement, while that evidence exists (SIGNAL SQLSTATE '45000').

const fs = require('fs');
const path = require('path');

const ROLLBACKS = path.join(__dirname, '../database/rollbacks');

// Tables whose rows are legal or regulatory evidence.
const EVIDENCE_TABLES = [
  'signed_documents', 'subscriber_consents', 'audit_logs', 'connection_logs',
  'radius_accounting_events', 'ip_attribution_case_evidence', 'preservation_holds',
  'government_data_requests', 'cfdi_documents',
];

const DESTRUCTIVE = new RegExp(
  `\\b(?:DROP TABLE(?: IF EXISTS)?|DELETE FROM|TRUNCATE(?: TABLE)?|ALTER TABLE)\\s+\`?(${EVIDENCE_TABLES.join('|')})\\b[^;]*`,
  'gi',
);

function offenders(sql) {
  const found = [];
  for (const m of sql.matchAll(DESTRUCTIVE)) {
    const statement = m[0];
    if (/^ALTER TABLE/i.test(statement) && !/\bDROP\b/i.test(statement)) continue;
    const before = sql.slice(0, m.index);
    if (!/SIGNAL SQLSTATE '45000'/.test(before)) found.push(statement.slice(0, 80));
  }
  return found;
}

test('the rule catches an unguarded drop and accepts a guarded one', () => {
  expect(offenders('DROP TABLE signed_documents;')).toHaveLength(1);
  expect(offenders('ALTER TABLE subscriber_consents DROP COLUMN captured_by;')).toHaveLength(1);
  expect(offenders('ALTER TABLE subscriber_consents ADD COLUMN x INT;')).toHaveLength(0);
  expect(offenders(`IF EXISTS (SELECT 1 FROM signed_documents LIMIT 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'evidence exists';
  END IF;
  DROP TABLE signed_documents;`)).toHaveLength(0);
});

test('no rollback destroys evidence without refusing first', () => {
  const bad = fs.readdirSync(ROLLBACKS).filter(f => f.endsWith('.sql'))
    .flatMap(file => offenders(fs.readFileSync(path.join(ROLLBACKS, file), 'utf8')).map(s => `${file}: ${s}`));
  expect(bad).toEqual([]);
});
