'use strict';
// Terminating a contract is one implementation, shared by the Terminate
// action and by a technology transition ending the contract it replaces.

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const mockUpdate = jest.fn();
jest.mock('../src/models/Contract', () => ({ update: (...a) => mockUpdate(...a), tableName: 'contracts' }));
const mockSync = jest.fn(async () => {});
jest.mock('../src/services/radiusService', () => ({ syncFreeradiusContract: (...a) => mockSync(...a) }));
const mockDisconnect = jest.fn(async () => {});
jest.mock('../src/services/suspensionService', () => ({ sendRadiusDisconnect: (...a) => mockDisconnect(...a) }));
const mockPickup = jest.fn(async () => {});
jest.mock('../src/services/inventorySerialService', () => ({ ensurePickupWorkOrder: (...a) => mockPickup(...a) }));
const mockAudit = jest.fn(async () => {});
jest.mock('../src/services/auditLog', () => ({ log: (...a) => mockAudit(...a) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const { terminateContract } = require('../src/services/contractTerminationService');

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

test('ends service: status, RADIUS account, live session, equipment pickup, audit', async () => {
  db.query.mockResolvedValueOnce([[{ id: 10, status: 'active' }]]).mockResolvedValue([{ affectedRows: 1 }]);
  mockUpdate.mockResolvedValue({ id: 10, status: 'terminated' });
  await expect(terminateContract(10, 3, { userId: 9, summary: 'Replaced by contract #77' })).resolves.toEqual({ id: 10, status: 'terminated' });
  expect(db.query.mock.calls[0]).toEqual(['SELECT * FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [10, 3]]);
  expect(mockUpdate).toHaveBeenCalledWith(10, { status: 'terminated' }, 3);
  expect(db.query.mock.calls[1]).toEqual(["UPDATE radius SET status = 'inactive' WHERE contract_id = ? AND organization_id = ? AND deleted_at IS NULL", [10, 3]]);
  expect(mockSync).toHaveBeenCalledWith(10, { organizationId: 3, enabled: false });
  expect(mockDisconnect).toHaveBeenCalledWith(10);
  expect(mockPickup).toHaveBeenCalledWith(10, { orgId: 3, performedBy: 9 });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'terminate', recordId: 10, summary: 'Replaced by contract #77', oldValues: { status: 'active' } }));
});

test('another organization\'s contract is 404 and nothing is touched', async () => {
  db.query.mockResolvedValueOnce([[]]);
  await expect(terminateContract(10, 3)).rejects.toMatchObject({ statusCode: 404 });
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('only a contract in service can be terminated', async () => {
  for (const status of ['pending', 'cancelled', 'terminated', 'expired']) {
    db.query.mockReset();
    db.query.mockResolvedValueOnce([[{ id: 10, status }]]);
    await expect(terminateContract(10, 3)).rejects.toMatchObject({ statusCode: 422, code: 'NOT_TERMINABLE' });
  }
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('a failed disconnect or FreeRADIUS cleanup does not undo the termination', async () => {
  db.query.mockResolvedValueOnce([[{ id: 10, status: 'suspended' }]]).mockResolvedValue([{ affectedRows: 1 }]);
  mockUpdate.mockResolvedValue({ id: 10, status: 'terminated' });
  mockSync.mockRejectedValueOnce(new Error('freeradius down'));
  mockDisconnect.mockRejectedValueOnce(new Error('no CoA'));
  await expect(terminateContract(10, 3)).resolves.toMatchObject({ status: 'terminated' });
});

test('the Terminate route uses it', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'contracts.js'), 'utf8');
  expect(routes).toMatch(/router\.post\('\/:id\/terminate'[^\n]*\n\s+try \{\n\s+const record = await terminateContract\(req\.params\.id, req\.orgId, \{ userId: req\.user\?\.id \|\| null \}\);/);
});
