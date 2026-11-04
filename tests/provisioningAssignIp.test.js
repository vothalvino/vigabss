// =============================================================================
// ASY-36 — the provisioning pipeline's assign_ip stage assigns an address
// =============================================================================
// assign_ip assigned nothing: it reported 0.0.0.0 (TNB-37 made it say "not
// implemented"). It now keeps the contract's active address or takes the
// next free one from the chosen pool through poolAssignmentService.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), getConnection: jest.fn(),
  withPrimaryContext: fn => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/poolAssignmentService', () => ({ assignNextFreeIp: jest.fn() }));

const db = require('../src/config/database');
const poolAssignmentService = require('../src/services/poolAssignmentService');
const automation = require('../src/services/automationService');

let existing;
beforeEach(() => {
  jest.clearAllMocks();
  existing = null;
  db.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT id, client_id FROM contracts WHERE id = \? AND organization_id = \?/.test(sql)) {
      return [params[0] === 5 && params[1] === 1 ? [{ id: 5, client_id: 2 }] : []];
    }
    if (/FROM ip_assignments\s+WHERE contract_id = \?/.test(sql)) return [existing ? [existing] : []];
    if (/INSERT INTO provisioning_pipelines/.test(sql)) return [{ insertId: 1 }];
    if (/SELECT \* FROM provisioning_pipelines/.test(sql)) return [[{ id: 1 }]];
    return [{ affectedRows: 1, insertId: 1 }];
  });
  poolAssignmentService.assignNextFreeIp.mockResolvedValue({ id: 77, pool_id: 3, ip_address: '100.64.0.10' });
});

function stage(name) {
  const call = db.query.mock.calls.find(([sql, p]) => /UPDATE provisioning_pipeline_stages/.test(sql) && p[4] === name);
  return { status: call[1][0], output: JSON.parse(call[1][1]), error: call[1][2] };
}

test('takes the next free address from the chosen pool for the contract', async () => {
  await automation.runProvisioningPipeline(1, { name: 'p', contract_id: 5, ip_pool_id: 3, triggered_by: 9 });
  expect(poolAssignmentService.assignNextFreeIp).toHaveBeenCalledWith(3, { contractId: 5, clientId: 2, orgId: 1 });
  expect(stage('assign_ip')).toMatchObject({ status: 'completed', output: { assigned_ip: '100.64.0.10', pool_id: 3, assignment_id: 77 } });
});

test('keeps the contract\'s active address instead of assigning a second one', async () => {
  existing = { ip_address: '100.64.0.4', pool_id: 3 };
  await automation.runProvisioningPipeline(1, { name: 'p', contract_id: 5, ip_pool_id: 3 });
  expect(poolAssignmentService.assignNextFreeIp).not.toHaveBeenCalled();
  expect(stage('assign_ip')).toMatchObject({ status: 'completed', output: { assigned_ip: '100.64.0.4', reused: true } });
});

test('without a pool or an address the stage is skipped, never completed with a fake address', async () => {
  await automation.runProvisioningPipeline(1, { name: 'p', contract_id: 5 });
  expect(stage('assign_ip')).toMatchObject({ status: 'skipped', output: { skipped: true } });
  expect(JSON.stringify(stage('assign_ip'))).not.toMatch(/0\.0\.0\.0/);
});

test('a contract of another organization fails the stage and assigns nothing', async () => {
  await automation.runProvisioningPipeline(2, { name: 'p', contract_id: 5, ip_pool_id: 3 });
  expect(poolAssignmentService.assignNextFreeIp).not.toHaveBeenCalled();
  expect(stage('assign_ip')).toMatchObject({ status: 'failed', error: expect.stringMatching(/does not belong/) });
});

test('a full pool fails the stage with the pool\'s reason', async () => {
  poolAssignmentService.assignNextFreeIp.mockRejectedValue(Object.assign(new Error('No free IPv4 addresses available in pool'), { status: 422 }));
  await automation.runProvisioningPipeline(1, { name: 'p', contract_id: 5, ip_pool_id: 3 });
  expect(stage('assign_ip')).toMatchObject({ status: 'failed', error: 'No free IPv4 addresses available in pool' });
});
