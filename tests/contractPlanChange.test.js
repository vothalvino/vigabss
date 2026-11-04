// =============================================================================
// ASY-15 — a plan change reaches the network
// =============================================================================
// PUT /contracts/:id, an approved portal plan change and a batch change_plan
// all wrote contracts.plan_id and stopped: external FreeRADIUS kept the old
// plan group until a full sync and the live session kept the old rate until
// the subscriber reconnected. The batch also skipped the guard that keeps a
// prepared installation's fields from changing underneath it.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
jest.mock('../src/services/radiusService', () => ({
  syncFreeradiusTables: jest.fn(async () => ({ synced: 1 })),
  changeOfAuth: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../src/services/suspensionService', () => ({
  planRateAttributes: jest.fn(async () => [{ name: 'Mikrotik-Rate-Limit', value: '20M/100M' }]),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn(async () => undefined) }));
jest.mock('../src/services/contractUpdateGuard', () => ({ updateContractWithActivationGuard: jest.fn(async () => ({})) }));

const db = require('../src/config/database');
const radiusService = require('../src/services/radiusService');
const suspensionService = require('../src/services/suspensionService');
const { updateContractWithActivationGuard } = require('../src/services/contractUpdateGuard');
const { pushPlanChange } = require('../src/services/contractPlanChangeService');

const ACTIVE = {
  id: 8, status: 'active', plan_id: 3, soft_suspend_download_kbps: null, soft_suspend_upload_kbps: null,
  fup_throttle_active: 0, radius_vendor: 'mikrotik', fup_download_speed_mbps: 5, fup_upload_speed_mbps: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('pushPlanChange', () => {
  test('rewrites the contract\'s FreeRADIUS rows and sends the new plan rate to the session', async () => {
    db.query.mockResolvedValueOnce([[ACTIVE]]);
    expect(await pushPlanChange(8, 4)).toEqual({ pushed: true, synced: true, coa_sent: true });
    expect(db.query.mock.calls[0][1]).toEqual([8, 4]);
    expect(radiusService.syncFreeradiusTables).toHaveBeenCalledWith(4, { contractId: 8 });
    expect(suspensionService.planRateAttributes).toHaveBeenCalledWith(expect.anything(), 3);
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(8, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '20M/100M' }]);
  });

  test('a FUP-throttled contract stays throttled, at the new plan\'s FUP rate', async () => {
    db.query.mockResolvedValueOnce([[{ ...ACTIVE, fup_throttle_active: 1 }]]);
    await pushPlanChange(8, 4);
    expect(suspensionService.planRateAttributes).not.toHaveBeenCalled();
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(8, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '1000k/5000k' }]);
  });

  test('a soft-suspended contract keeps its suspension throttle', async () => {
    db.query.mockResolvedValueOnce([[{ ...ACTIVE, soft_suspend_download_kbps: 256, soft_suspend_upload_kbps: 128 }]]);
    await pushPlanChange(8, 4);
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(8, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '128k/256k' }]);
  });

  test('a contract that is not active, or another organization\'s, is left alone', async () => {
    db.query.mockResolvedValueOnce([[{ ...ACTIVE, status: 'suspended' }]]);
    expect(await pushPlanChange(8, 4)).toEqual({ pushed: false, reason: 'not_active' });
    db.query.mockResolvedValueOnce([[]]);
    expect(await pushPlanChange(8, 5)).toEqual({ pushed: false, reason: 'not_found' });
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
    expect(radiusService.syncFreeradiusTables).not.toHaveBeenCalled();
  });

  test('a RADIUS failure is reported, never thrown: the plan change stands', async () => {
    db.query.mockResolvedValueOnce([[ACTIVE]]);
    radiusService.syncFreeradiusTables.mockRejectedValueOnce(new Error('db down'));
    radiusService.changeOfAuth.mockRejectedValueOnce(new Error('timeout'));
    expect(await pushPlanChange(8, 4)).toEqual({ pushed: true, synced: false, coa_sent: false });
  });
});

describe('batch change_plan', () => {
  const automationService = require('../src/services/automationService');

  test('goes through the contract update guard, then the network', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 10, plan_id: 3, status: 'active' }]])
      .mockResolvedValueOnce([[{ ...ACTIVE, id: 10, plan_id: 4 }]]);
    await automationService.applyBatchOperation(1, 'change_plan', { entity_id: 10 }, { plan_id: 4 }, 7);
    expect(updateContractWithActivationGuard).toHaveBeenCalledWith(expect.objectContaining({ id: 10, plan_id: 3 }), { plan_id: 4 }, 1);
    expect(radiusService.changeOfAuth).toHaveBeenCalledWith(10, 'update', expect.any(Array));
    expect(db.query.mock.calls.some(([sql]) => /UPDATE contracts SET plan_id/.test(sql))).toBe(false);
  });

  test('a prepared installation refuses the change for that contract', async () => {
    db.query.mockResolvedValueOnce([[{ id: 10, plan_id: 3, status: 'active' }]]);
    updateContractWithActivationGuard.mockRejectedValueOnce(new Error('Finish or cancel the prepared/in-process installation before changing activation fields: plan_id'));
    await expect(automationService.applyBatchOperation(1, 'change_plan', { entity_id: 10 }, { plan_id: 4 }, 7))
      .rejects.toThrow(/prepared/);
    expect(radiusService.changeOfAuth).not.toHaveBeenCalled();
  });

  test('a contract already on the plan is skipped', async () => {
    db.query.mockResolvedValueOnce([[{ id: 10, plan_id: 4, status: 'active' }]]);
    expect(await automationService.applyBatchOperation(1, 'change_plan', { entity_id: 10 }, { plan_id: 4 }, 7))
      .toEqual({ skipped: true, message: 'Already on this plan' });
    expect(updateContractWithActivationGuard).not.toHaveBeenCalled();
  });
});
