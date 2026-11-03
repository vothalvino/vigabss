'use strict';
// =============================================================================
// Install-wide tasks reach isolated tenants and skip their stale primary rows
// =============================================================================
// These handlers took a NULL organization as "every organization" by dropping
// the filter by hand, so they ran on the primary database only: an isolated
// tenant's NAS were never checked, its RADIUS rows never synced, its windows
// never applied, and the stale copy of its rows on the primary was processed
// instead. They now run once on the primary, excluding isolated organizations
// (orgScopeFilter), and once inside each isolated tenant's database.
// =============================================================================

const mockCalls = [];
let mockContext = 'primary';

jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params = []) => {
    mockCalls.push({ sql, params, context: mockContext });
    if (/FROM organization_database_configs odc\s+JOIN organizations/.test(sql)) return [[{ organization_id: 7 }]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 0 }];
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 0 }]];
    return [[]];
  }),
  execute: jest.fn(async () => [[]]),
  getConnection: jest.fn(),
  withPrimaryContext: async (fn) => { const prev = mockContext; mockContext = 'primary'; try { return await fn(); } finally { mockContext = prev; } },
  withTenantContext: async (orgId, fn) => { const prev = mockContext; mockContext = `tenant:${orgId}`; try { return await fn(); } finally { mockContext = prev; } },
  baseConnectionConfig: { database: 'vigabss_test' },
}));

const { runTask } = require('../src/services/taskRunner');

beforeEach(() => { mockCalls.length = 0; mockContext = 'primary'; });

// Task → a table its handler reads, to find the scoped query.
test.each([
  ['nas_health_check', /FROM nas\b/],
  ['maintenance_window_expiry', /UPDATE maintenance_windows/],
  ['check_certificate_expiry', /FROM subscriber_certificates/],
  ['kick_duplicate_sessions', /FROM radius r\s+LEFT JOIN contracts c/],
  ['apply_speed_windows', /FROM plans p/],
  ['rollover_balance_accrue', /FROM contracts c\s+JOIN plans p/],
  ['inventory_low_stock_check', /FROM inventory_items i/],
  ['data_retention_compliance_check', /FROM dsar_requests/],
  ['radius_sync', /SELECT c\.id FROM contracts c/],
  ['populate_network_health_snapshots', /FROM snmp_metrics_1hr/],
])('%s runs on the primary without isolated tenants, then in each isolated tenant', async (task, table) => {
  await runTask(task, null);

  const scoped = mockCalls.filter(c => table.test(c.sql));
  const primary = scoped.find(c => c.context === 'primary');
  const tenant = scoped.find(c => c.context === 'tenant:7');
  expect(primary).toBeDefined();
  expect(primary.sql).toMatch(/NOT IN \(\?\)/);
  expect(primary.params).toContain(7);
  expect(tenant).toBeDefined();
  expect(tenant.sql).toMatch(/organization_id\)? = \?/);
  expect(tenant.params).toContain(7);
});

test('populate_revenue_summary aggregates each organization in its own database', async () => {
  const db = require('../src/config/database');
  const listOrgs = /SELECT o\.id,\s+CASE WHEN odc\.isolation_mode/;
  db.query.mockImplementation(async (sql, params = []) => {
    mockCalls.push({ sql, params, context: mockContext });
    if (listOrgs.test(sql)) return [[{ id: 3, database_scope: 'shared' }, { id: 7, database_scope: 'isolated' }]];
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) return [{ affectedRows: 0 }];
    return [[{}]];
  });

  await runTask('populate_revenue_summary', null);

  const contexts = new Set(mockCalls.filter(c => c.params.includes(7) && !listOrgs.test(c.sql)).map(c => c.context));
  expect([...contexts]).toEqual(['tenant:7']);
});
