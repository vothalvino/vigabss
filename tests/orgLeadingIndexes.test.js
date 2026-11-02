// =============================================================================
// DB-24 — organization-leading list indexes exist, and cfdi_documents.uuid is
// unique once
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');
const table = (name) => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  return schema.slice(start, schema.indexOf(') ENGINE', start));
};

test.each([
  ['payments', 'idx_payments_org_payment_date', 'organization_id, payment_date'],
  ['payments', 'idx_payments_org_created', 'organization_id, created_at'],
  ['tickets', 'idx_tickets_org_status_created', 'organization_id, status, created_at'],
  ['work_orders', 'idx_wo_org_status_created', 'organization_id, status, created_at'],
])('%s has %s', (name, index, columns) => {
  expect(table(name)).toContain(`KEY ${index} (${columns})`);
  expect(fs.readFileSync(path.join(root, 'database/migrations/501_org_leading_list_indexes.sql'), 'utf8'))
    .toContain(`'${name}', '${index}', '${columns}'`);
});

test('cfdi_documents.uuid has exactly one unique index', () => {
  const body = table('cfdi_documents');
  expect(body).not.toMatch(/\n\s+uuid\s+CHAR\(36\)\s+NULL\s+UNIQUE/);
  expect(body.match(/UNIQUE KEY \w+ \(uuid\)/g)).toHaveLength(1);
});
