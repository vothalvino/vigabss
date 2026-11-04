// =============================================================================
// NET-26 — the SNMP discovery executor
// =============================================================================
// discovery_scans rows stayed 'pending' and discovery_results was never
// written. runScan expands the ranges behind the management-target guard,
// probes each host with bounded concurrency and records what answered.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getLockConnection: jest.fn() }));
jest.mock('../src/utils/advisoryLock', () => ({ withAdvisoryLock: jest.fn(async (_key, fn) => { await fn(); return true; }) }));
jest.mock('net-snmp', () => ({ isVarbindError: () => false }), { virtual: true });
jest.mock('../src/services/snmpPoller', () => ({ createSnmpSession: jest.fn(), snmpGet: jest.fn() }));

const db = require('../src/config/database');
const snmpPoller = require('../src/services/snmpPoller');
const svc = require('../src/services/discoveryScanService');

const ORG = 10;
const SCAN = { id: 4, organization_id: ORG, cidr_ranges: '["192.168.5.0/29"]', snmp_version: 'v2c', snmp_community: 'enc', snmp_port: 161, timeout_ms: 1000, concurrency: 3, status: 'pending' };

describe('expandCidrs', () => {
  test('drops network and broadcast, keeps /31 and /32 whole', () => {
    expect(svc.expandCidrs(['192.168.5.0/30'])).toEqual(['192.168.5.1', '192.168.5.2']);
    expect(svc.expandCidrs(['192.168.5.0/31'])).toEqual(['192.168.5.0', '192.168.5.1']);
    expect(svc.expandCidrs('["192.168.5.9"]')).toEqual(['192.168.5.9']);
  });

  test('refuses ranges the management-target guard refuses, bad input and oversize scans', () => {
    for (const bad of [['127.0.0.1'], ['169.254.169.254/32'], ['224.0.0.0/30'], ['10.0.0.0/16'], ['10.0.0.300'], ['fe80::1'], []]) {
      expect(() => svc.expandCidrs(bad)).toThrow();
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `10.${i}.0.0/24`);
    expect(() => svc.expandCidrs(twenty)).toThrow(/at most 4096/);
  });
});

describe('classify', () => {
  test('reads the vendor from the sysObjectID enterprise number', () => {
    expect(svc.classify({ sysObjectID: '1.3.6.1.4.1.14988.1', sysDescr: 'RouterOS CCR2004-16G-2S+' }))
      .toEqual({ manufacturer: 'MikroTik', model: 'CCR2004-16G-2S+', deviceType: 'router' });
    expect(svc.classify({ sysObjectID: '1.3.6.1.4.1.2011.2.248', sysDescr: 'Huawei Integrated Access Software MA5683T OLT' }))
      .toMatchObject({ manufacturer: 'Huawei', deviceType: 'olt' });
    expect(svc.classify({ sysObjectID: '1.3.6.1.4.1.99999.1', sysDescr: 'something' }))
      .toEqual({ manufacturer: null, model: null, deviceType: 'other' });
  });
});

describe('runScan', () => {
  let state;
  beforeEach(() => {
    jest.clearAllMocks();
    state = { status: 'pending', inserts: [], updates: [] };
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT \* FROM discovery_scans/.test(sql)) return [[state.status === 'pending' || state.status === 'running' ? { ...SCAN, status: state.status } : undefined].filter(Boolean)];
      if (/SET status = 'running'/.test(sql)) { state.status = 'running'; return [{ affectedRows: 1 }]; }
      if (/SELECT status, deleted_at FROM discovery_scans/.test(sql)) return [[{ status: state.status, deleted_at: null }]];
      if (/SET status = 'completed'/.test(sql)) {
        const ok = state.status === 'running';
        if (ok) state.status = 'completed';
        return [{ affectedRows: ok ? 1 : 0 }];
      }
      if (/FROM devices/.test(sql)) return [[{ ip_address: '192.168.5.2' }]];
      if (/FROM snmp_profiles/.test(sql)) return [[{ id: 31 }]];
      if (/INSERT INTO discovery_results/.test(sql)) { state.inserts.push(params); return [{ insertId: state.inserts.length }]; }
      if (/UPDATE discovery_scans SET scanned_hosts/.test(sql)) { state.updates.push(params); return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    });
    snmpPoller.createSnmpSession.mockImplementation(device => ({ ip: device.ip_address, close: jest.fn() }));
  });

  test('records responders, skips known devices, bounds concurrency and completes', async () => {
    let inFlight = 0;
    let peak = 0;
    snmpPoller.snmpGet.mockImplementation(async (session) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      if (session.ip === '192.168.5.1') return [{ value: Buffer.from('RouterOS RB4011') }, { value: '1.3.6.1.4.1.14988.1' }, { value: Buffer.from('pop-1') }];
      throw new Error('Request timed out');
    });

    const outcome = await svc.runScan(4, ORG);

    expect(outcome).toEqual({ status: 'completed', scanned: 6, discovered: 1 });
    expect(peak).toBeLessThanOrEqual(3);
    // .2 is already a device of the organization: never probed.
    expect(snmpPoller.createSnmpSession.mock.calls.map(([d]) => d.ip_address)).not.toContain('192.168.5.2');
    expect(snmpPoller.createSnmpSession).toHaveBeenCalledWith(expect.objectContaining({ snmp_community: 'enc' }), { timeout: 1000, retries: 0 });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toEqual([4, ORG, '192.168.5.1', 'pop-1', 'RouterOS RB4011', '1.3.6.1.4.1.14988.1', 2, 'MikroTik', 'RB4011', 'router', 31]);
    expect(state.updates.at(-1)).toEqual([6, 1, 4, ORG]);
    // Every statement is bound to the scan's organization.
    for (const [sql, params] of db.query.mock.calls) if (/discovery_|devices|snmp_profiles/.test(sql)) expect(params).toContain(ORG);
  });

  test('a scan that is not pending or running is left alone', async () => {
    state.status = 'completed';
    await expect(svc.runScan(4, ORG)).resolves.toEqual({ status: 'skipped' });
    expect(snmpPoller.snmpGet).not.toHaveBeenCalled();
  });

  test('a cancelled scan stops between batches and is not marked completed', async () => {
    const big = { ...SCAN, cidr_ranges: '["192.168.6.0/24"]', concurrency: 1 };
    db.query.mockImplementationOnce(async () => [[big]]);
    snmpPoller.snmpGet.mockImplementation(async () => { state.status = 'cancelled'; throw new Error('timeout'); });
    const outcome = await svc.runScan(4, ORG);
    expect(outcome.status).toBe('stopped');
    expect(outcome.scanned).toBe(32);
    expect(state.status).toBe('cancelled');
  });

  test('a range that became invalid fails the scan with the reason', async () => {
    db.query.mockImplementationOnce(async () => [[{ ...SCAN, cidr_ranges: '["127.0.0.1"]' }]]);
    await expect(svc.runScan(4, ORG)).resolves.toEqual({ status: 'failed' });
    const failed = db.query.mock.calls.find(([sql]) => /SET status = 'failed'/.test(sql));
    expect(failed[1][0]).toMatch(/127\.0\.0\.1/);
  });
});
