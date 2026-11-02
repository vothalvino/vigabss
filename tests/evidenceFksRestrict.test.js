// =============================================================================
// DB-26 — evidence tables restrict deletes of their client or organization
// =============================================================================
// signed_documents, subscriber_consents and dsar_requests cascaded from
// clients, and audit_logs and ift_statistical_reports from organizations; a
// cascade also bypasses audit_logs' immutability triggers.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');

test.each([
  ['fk_signed_documents_client', 'clients'],
  ['fk_sub_consents_client', 'clients'],
  ['fk_dsar_requests_client', 'clients'],
  ['fk_audit_logs_org', 'organizations'],
  ['fk_ift_statistical_reports_organization', 'organizations'],
])('%s is ON DELETE RESTRICT in schema.sql and migration 502', (constraint, parent) => {
  expect(schema).toMatch(new RegExp(`CONSTRAINT ${constraint} FOREIGN KEY \\(\\w+\\)\\s+REFERENCES ${parent} \\(id\\) ON DELETE RESTRICT`));
  expect(fs.readFileSync(path.join(root, 'database/migrations/502_evidence_fks_restrict.sql'), 'utf8')).toContain(`'${constraint}'`);
});
