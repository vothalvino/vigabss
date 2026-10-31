// =============================================================================
// ASY-06 — install-wide tasks reach isolated-tenant databases
// =============================================================================
// Cron and BullMQ callbacks carry no tenant context, so billing, autopay,
// retries, ticket automation, certificate/SLA checks, reports and SNMP polling
// ran against the primary database only: an isolated organization was never
// invoiced, suspended, charged or polled, and the stale primary copy of its
// rows could be. They now run once on the primary (isolated organizations
// excluded) and once inside each isolated organization's database.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');

const mockScope = new AsyncLocalStorage();
const mockCalls = [];
const mockState = { isolated: [7] };

jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params = []) => {
    mockCalls.push({ where: mockScope.getStore() || 'primary', sql, params });
    if (/FROM organization_database_configs odc/.test(sql)) return [mockState.isolated.map(id => ({ organization_id: id }))];
    return [[]];
  }),
  getConnection: jest.fn(),
  withTenantContext: jest.fn((orgId, fn) => mockScope.run(`tenant:${orgId}`, fn)),
  withPrimaryContext: jest.fn(fn => mockScope.run('primary', fn)),
  baseConnectionConfig: { database: 'vigabss_test' },
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const { forEachDatabaseScope, orgScopeFilter } = require('../src/services/organizationFanOut');
const taskRunner = require('../src/services/taskRunner');

beforeEach(() => {
  mockCalls.length = 0;
  mockState.isolated = [7];
});

describe('forEachDatabaseScope', () => {
  test('runs on the primary without the isolated orgs, then inside each isolated org', async () => {
    const seen = [];
    await forEachDatabaseScope('t', async orgId => {
      seen.push({ orgId, filter: orgScopeFilter('c.organization_id', orgId) });
    });
    expect(seen).toEqual([
      { orgId: null, filter: { sql: ' AND (c.organization_id IS NULL OR c.organization_id NOT IN (?))', params: [7] } },
      { orgId: 7, filter: { sql: ' AND c.organization_id = ?', params: [7] } },
    ]);
  });

  test('a failing scope does not stop the others, and the run is reported failed', async () => {
    const ran = [];
    await expect(forEachDatabaseScope('t', async orgId => {
      ran.push(orgId);
      if (orgId === null) throw new Error('primary down');
    })).rejects.toThrow(/failed in 1 of 2 database scope/);
    expect(ran).toEqual([null, 7]);
  });

  test('with no isolated organizations it is the old single primary run', async () => {
    mockState.isolated = [];
    const handler = jest.fn(async orgId => ({ orgId, filter: orgScopeFilter('x.organization_id', orgId) }));
    expect(await forEachDatabaseScope('t', handler)).toEqual({ orgId: null, filter: { sql: '', params: [] } });
  });
});

describe('scheduled tasks', () => {
  const contractQueries = () => mockCalls.filter(c => /FROM contracts c/.test(c.sql));

  test('auto_generate_invoices reads contracts on the primary (isolated excluded) and in the isolated database', async () => {
    await taskRunner.runTask('auto_generate_invoices', null);
    const [primary, tenant] = contractQueries();
    expect(primary.where).toBe('primary');
    expect(primary.sql).toMatch(/c\.organization_id NOT IN \(\?\)/);
    expect(primary.params).toEqual([7]);
    expect(tenant.where).toBe('tenant:7');
    expect(tenant.sql).toMatch(/c\.organization_id = \?/);
    expect(tenant.params).toEqual([7]);
  });

  test.each([
    ['process_recurring_charges', /FROM recurring_payment_profiles rp/],
    ['retry_failed_charges', /FROM payment_retries pr/],
    ['follow_up_reminders', /FROM follow_up_reminders r/],
    ['auto_escalate_tickets', /FROM tickets t/],
    ['generate_scheduled_reports', /FROM scheduled_reports sr/],
  ])('%s also runs in the isolated database', async (taskName, table) => {
    await taskRunner.runTask(taskName, null);
    const scopes = mockCalls.filter(c => table.test(c.sql)).map(c => c.where);
    expect(scopes).toEqual(['primary', 'tenant:7']);
  });

  test("a task row owned by one organization runs in that organization's database", async () => {
    await taskRunner.runTask('auto_generate_invoices', 7);
    const queries = contractQueries();
    expect(queries).toHaveLength(1);
    expect(queries[0].where).toBe('tenant:7');
  });
});
