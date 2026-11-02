// =============================================================================
// RTE-11 — churn and at-risk reports ignore soft-deleted rows
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), queryReplica: jest.fn(async () => [[]]) }));
const db = require('../src/config/database');
const lifecycle = require('../src/services/lifecycleService');

beforeEach(() => jest.clearAllMocks());
const sql = () => db.queryReplica.mock.calls[0][0];

test('the churn report counts live contracts only', async () => {
  await lifecycle.churnReport(1);
  expect(sql()).toMatch(/c\.deleted_at IS NULL/);
});

test('at-risk joins only live contracts and invoices of the same organization', async () => {
  await lifecycle.atRiskClients(1);
  expect(sql()).toMatch(/LEFT JOIN contracts co ON co\.client_id = cl\.id\s+AND co\.deleted_at IS NULL AND co\.organization_id <=> cl\.organization_id/);
  expect(sql()).toMatch(/LEFT JOIN invoices i ON i\.client_id = cl\.id\s+AND i\.deleted_at IS NULL AND i\.organization_id <=> cl\.organization_id/);
});

test('win-back targets skip deleted contracts', async () => {
  await lifecycle.winbackTargets('all_cancelled', 1);
  expect(sql()).toMatch(/co\.deleted_at IS NULL/);
});
