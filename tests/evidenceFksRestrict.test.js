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
const { baselineSql } = require('./helpers/baseline');
const schema = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');

test.each([
  ['fk_signed_documents_client', 'clients'],
  ['fk_sub_consents_client', 'clients'],
  ['fk_dsar_requests_client', 'clients'],
  ['fk_audit_logs_org', 'organizations'],
  ['fk_ift_statistical_reports_organization', 'organizations'],
])('%s is ON DELETE RESTRICT in schema.sql and the baseline', (constraint, parent) => {
  expect(schema).toMatch(new RegExp(`CONSTRAINT ${constraint} FOREIGN KEY \\(\\w+\\)\\s+REFERENCES ${parent} \\(id\\) ON DELETE RESTRICT`));
  // MySQL prints RESTRICT as the absence of an ON DELETE clause (NO ACTION and
  // RESTRICT behave the same in InnoDB), so the dump must not name another action.
  const fk = baselineSql().match(new RegExp(`CONSTRAINT \`${constraint}\` FOREIGN KEY [^\\n]*`))?.[0];
  expect(fk).toBeDefined();
  expect(fk).toContain(`REFERENCES \`${parent}\` (\`id\`)`);
  expect(fk).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
});
