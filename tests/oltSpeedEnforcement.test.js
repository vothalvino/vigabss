'use strict';
// =============================================================================
// FTTH speed is enforced on the OLT, not on the BNG
// =============================================================================
// A contract whose ONU VigaBSS provisioned (switched on, with a service-port)
// is rate-limited by the OLT. RADIUS then sends it NO plan rate limit; a
// throttle (FUP, soft suspension) still goes to the BNG because it is below
// the OLT's limit. A contract with no such ONU keeps its BNG limit, so nobody
// is left with no limit anywhere.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
const mockSync = jest.fn(async () => ({}));
const mockCoa = jest.fn(async () => ({ sent: true }));
jest.mock('../src/services/radiusService', () => ({
  syncFreeradiusTables: (...a) => mockSync(...a), changeOfAuth: (...a) => mockCoa(...a), disconnectSession: jest.fn(async () => ({ sent: true })),
}));
const mockPlanRate = jest.fn(async () => [{ name: 'Mikrotik-Rate-Limit', value: '20M/100M' }]);
jest.mock('../src/services/suspensionService', () => ({ planRateAttributes: (...a) => mockPlanRate(...a) }));
const mockSetSpeed = jest.fn(async () => ({ applied: true, up_kbps: 20000, down_kbps: 100000 }));
jest.mock('../src/services/olt/oltProvisioningService', () => ({ setSpeed: (...a) => mockSetSpeed(...a) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const attrs = require('../src/services/radiusAttributeService');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ACTIVE = { id: 8, status: 'active', plan_id: 3, radius_vendor: 'mikrotik', soft_suspend_download_kbps: null, soft_suspend_upload_kbps: null, fup_throttle_active: 0 };

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

describe('which contracts the OLT enforces', () => {
  test('one whose ONU is provisioned, switched on and has a service-port', () => {
    expect(attrs.oltEnforcedSql('c')).toBe(
      '(EXISTS (SELECT 1 FROM olt_onus oe WHERE oe.contract_id = c.id AND oe.active = 1 AND oe.service_port_index IS NOT NULL))',
    );
    expect(() => attrs.oltEnforcedSql('c; DROP')).toThrow();
  });

  test('the single-contract check asks the same thing, within the organization', async () => {
    db.query.mockResolvedValueOnce([[{ 1: 1 }]]);
    await expect(attrs.isOltEnforced(db, 8, 4)).resolves.toBe(true);
    expect(db.query.mock.calls[0][0].replace(/\s+/g, ' ')).toBe(
      'SELECT 1 FROM olt_onus WHERE contract_id = ? AND (? IS NULL OR organization_id = ?) AND active = 1 AND service_port_index IS NOT NULL LIMIT 1',
    );
    expect(db.query.mock.calls[0][1]).toEqual([8, 4, 4]);
    db.query.mockResolvedValueOnce([[]]);
    await expect(attrs.isOltEnforced(db, 8, 4)).resolves.toBe(false);
    await expect(attrs.isOltEnforced(db, null, 4)).resolves.toBe(false);
  });
});

describe('what RADIUS sends at sign-in', () => {
  test('the built-in server sends no plan rate to an OLT-enforced contract, but still sends a throttle', () => {
    const src = read('src', 'services', 'radiusServerService.js');
    expect(src).toMatch(/\$\{oltEnforcedSql\('c'\)\} AS olt_enforced,/);
    expect(src).toMatch(/const attrMap = throttle\s+\? generateThrottleAttributes\([^)]*\)\s+\/\/[^\n]*\n\s+: \(Number\(subscriber\.olt_enforced\) === 1 \? \{\} : generateAttributes\(plan\)\);/);
  });

  test('FreeRADIUS: such a contract is in a twin plan group with no rate limit, and gets no per-user rate', () => {
    const src = read('src', 'services', 'radiusService.js');
    expect(src).toMatch(/return oltEnforced \? `plan_\$\{planId\}_olt` : `plan_\$\{planId\}`;/);
    expect(src.match(/planGroupName\((account|sub)\.plan_id, Number\((account|sub)\.olt_enforced\) === 1\)/g)).toHaveLength(2);
    expect(src.match(/Number\((account|sub)\.olt_enforced\) === 1 \? \[\] : expandAttributeRows\(generateAttributes\((account|sub)\)\)/g)).toHaveLength(2);
    // The twin group gets the timeouts and login hours, never a rate row.
    const step = src.slice(src.indexOf('const oltGroup = planGroupName(planId, true);'), src.indexOf("logger.error({ err, planId }, 'Error syncing FreeRADIUS group rows for plan')"));
    expect(step.match(/\[oltGroup, '(Session-Timeout|Idle-Timeout|Login-Time)'/g)).toHaveLength(3);
    expect(step).toMatch(/\[group, row\.attribute, row\.op, row\.value\]/);
    expect(step).not.toMatch(/\[oltGroup, row\.attribute/);
  });
});

describe('a plan change', () => {
  const { pushPlanChange } = require('../src/services/contractPlanChangeService');

  test('goes to the OLT for an OLT-enforced contract, and no rate is sent to the BNG', async () => {
    db.query.mockResolvedValueOnce([[ACTIVE]]).mockResolvedValueOnce([[{ id: 9, olt_device_id: 7 }]]);
    const result = await pushPlanChange(8, 4);
    expect(mockSetSpeed).toHaveBeenCalledWith(4, 7, 9, {}, { apply: true });
    expect(mockCoa).not.toHaveBeenCalled();
    expect(mockPlanRate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pushed: true, coa_sent: false, olt: { enforced: true, onus: [{ onu_id: 9, changed: true, down_kbps: 100000 }] } });
    expect(db.query.mock.calls[1][1]).toEqual([8, 4]);
  });

  test('a throttled OLT-enforced contract keeps its throttle at the BNG', async () => {
    db.query
      .mockResolvedValueOnce([[{ ...ACTIVE, soft_suspend_download_kbps: 256, soft_suspend_upload_kbps: 128 }]])
      .mockResolvedValueOnce([[{ id: 9, olt_device_id: 7 }]]);
    await pushPlanChange(8, 4);
    expect(mockSetSpeed).toHaveBeenCalled();
    expect(mockCoa).toHaveBeenCalledWith(8, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '128k/256k' }]);
  });

  test('a contract the OLT does not enforce is unchanged: its plan rate goes to the BNG', async () => {
    db.query.mockResolvedValueOnce([[ACTIVE]]).mockResolvedValueOnce([[]]);
    const result = await pushPlanChange(8, 4);
    expect(mockSetSpeed).not.toHaveBeenCalled();
    expect(mockCoa).toHaveBeenCalledWith(8, 'update', [{ name: 'Mikrotik-Rate-Limit', value: '20M/100M' }]);
    expect(result.olt).toBeUndefined();
  });

  test('an OLT that refuses is reported, never thrown: the plan change stands', async () => {
    db.query.mockResolvedValueOnce([[ACTIVE]]).mockResolvedValueOnce([[{ id: 9, olt_device_id: 7 }]]);
    mockSetSpeed.mockRejectedValueOnce(new Error('The OLT refused "undo service-port 1002"'));
    const result = await pushPlanChange(8, 4);
    expect(result).toMatchObject({ pushed: true, olt: { onus: [{ onu_id: 9, changed: false, error: expect.stringContaining('refused') }] } });
  });
});

describe('lifting a throttle', () => {
  test('FUP and soft suspension drop the session of an OLT-enforced contract instead of sending a plan rate', () => {
    expect(read('src', 'services', 'fupService.js')).toMatch(/await isOltEnforced\(db, contractId, organizationId\)\s+\? await radiusService\.disconnectSession\(contractId\)/);
    const suspension = read('src', 'services', 'suspensionService.js');
    expect(suspension).toMatch(/const oltEnforced = wasThrottled && await isOltEnforced\(conn, contractId, orgParams\[0\] \?\? null\);/);
    expect(suspension).toMatch(/const coaResult = oltEnforced\s+\? await sendRadiusDisconnect\(contractId\)\s+: await sendRadiusCoA\(contractId, 'reconnect', restoreRate\);/);
  });

  test('time-based speed windows leave OLT-enforced sessions alone', () => {
    expect(read('src', 'services', 'speedWindowService.js')).toMatch(/AND NOT \$\{require\('\.\/radiusAttributeService'\)\.oltEnforcedSql\('c'\)\}`/);
  });
});
