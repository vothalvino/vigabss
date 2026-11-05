// =============================================================================
// NET-26 — CPE firmware campaigns reach the CPEs over TR-069 Download
// =============================================================================
// A campaign stayed 'scheduled' for good and no CPE was told to download
// anything. Launching queues one CWMP download task per targeted CPE of the
// organization, and the campaign's counters follow those tasks.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const db = require('../src/config/database');
const svc = require('../src/services/cpeFirmwareCampaignService');

const ORG = 10;
const VERSION = { id: 2, manufacturer: 'Huawei', model_name: 'HG8245H', version: 'V5R020', firmware_url: 'https://fw.example/hg.bin', file_size_bytes: 1024 };

let conn;
function fixture({ campaign, devices = [{ id: 71 }, { id: 72 }], version = VERSION, claim = 1 } = {}) {
  conn = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn().mockResolvedValue(), release: jest.fn(), query: jest.fn(async (sql) => (/UPDATE cpe_firmware_campaigns/.test(sql) ? [{ affectedRows: claim }] : [{ affectedRows: 1 }])) };
  db.getConnection.mockResolvedValue(conn);
  db.query.mockImplementation(async (sql) => {
    if (/FROM cpe_firmware_campaigns/.test(sql)) return [[campaign].filter(Boolean)];
    if (/FROM cpe_firmware_versions/.test(sql)) return [[version].filter(Boolean)];
    if (/FROM cpe_devices/.test(sql)) return [devices];
    return [{ affectedRows: 1 }];
  });
}

const scheduled = { id: 5, organization_id: ORG, status: 'scheduled', firmware_version_id: 2, target_device_ids: null };

beforeEach(() => jest.clearAllMocks());

describe('launch', () => {
  test('queues one download per matching CPE of the organization and runs the campaign', async () => {
    fixture({ campaign: scheduled });
    await svc.startCampaign(5, ORG, 1);

    const [targetSql, targetParams] = db.query.mock.calls.find(([sql]) => /FROM cpe_devices/.test(sql));
    expect(targetSql).toMatch(/organization_id = \? AND deleted_at IS NULL AND manufacturer = \? AND model_name = \?/);
    expect(targetParams).toEqual([ORG, 'Huawei', 'HG8245H']);

    const claim = conn.query.mock.calls.find(([sql]) => /SET status = 'running'/.test(sql));
    expect(claim[1]).toEqual([2, 5, ORG]);
    const [insertSql, [rows]] = conn.query.mock.calls.find(([sql]) => /INSERT INTO cpe_tasks/.test(sql));
    expect(insertSql).toMatch(/VALUES \?/);
    expect(rows.map(r => r[1])).toEqual([71, 72]);
    expect(rows[0].slice(0, 3)).toEqual([ORG, 71, 'download']);
    expect(JSON.parse(rows[0][3])).toEqual({
      url: VERSION.firmware_url, fileType: '1 Firmware Upgrade Image', fileSize: 1024, _campaignId: 5, _targetVersion: VERSION.version,
    });
    expect(conn.commit).toHaveBeenCalled();
  });

  test('explicit targets must all be the organization\'s CPEs', async () => {
    fixture({ campaign: { ...scheduled, target_device_ids: '[71,99]' }, devices: [{ id: 71 }] });
    await expect(svc.startCampaign(5, ORG)).rejects.toMatchObject({ statusCode: 422 });
    const [, params] = db.query.mock.calls.find(([sql]) => /FROM cpe_devices/.test(sql));
    expect(params).toEqual([[71, 99], ORG]);
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('a campaign that is not scheduled cannot be launched; no CPE matching is 422', async () => {
    fixture({ campaign: { ...scheduled, status: 'running' } });
    await expect(svc.startCampaign(5, ORG)).rejects.toMatchObject({ statusCode: 409 });
    fixture({ campaign: scheduled, devices: [] });
    await expect(svc.startCampaign(5, ORG)).rejects.toMatchObject({ statusCode: 422 });
  });

  test('a concurrent launch that loses the claim queues nothing', async () => {
    fixture({ campaign: scheduled, claim: 0 });
    await expect(svc.startCampaign(5, ORG)).rejects.toMatchObject({ statusCode: 409 });
    expect(conn.query.mock.calls.some(([sql]) => /INSERT INTO cpe_tasks/.test(sql))).toBe(false);
    expect(conn.rollback).toHaveBeenCalled();
  });

  test('a future scheduled_at is refused: nothing starts campaigns on a timer', () => {
    expect(() => svc.assertRunnable({ scheduled_at: new Date(Date.now() + 86400e3).toISOString() })).toThrow(expect.objectContaining({ statusCode: 501 }));
    expect(() => svc.assertRunnable({})).not.toThrow();
  });
});

describe('progress', () => {
  test('a settled download task recounts its campaign; done once nothing is open', async () => {
    db.query.mockImplementation(async (sql) => (/FROM cpe_tasks/.test(sql) ? [[{ ok: '2', failed: '1', open: '0' }]] : [{ affectedRows: 1 }]));
    await svc.afterTaskSettled({ id: 1, task_type: 'download', organization_id: ORG, parameters: '{"url":"x","_campaignId":5}' });
    const [countSql, countParams] = db.query.mock.calls[0];
    expect(countSql).toMatch(/JSON_EXTRACT\(parameters, '\$\._campaignId'\) = \?/);
    expect(countParams).toEqual([ORG, 5]);
    const [, updateParams] = db.query.mock.calls[1];
    expect(updateParams).toEqual([2, 1, 0, 5, ORG]);
  });

  test('other tasks are ignored', async () => {
    await svc.afterTaskSettled({ id: 1, task_type: 'reboot', parameters: '{"_campaignId":5}' });
    await svc.afterTaskSettled({ id: 2, task_type: 'download', parameters: '{"url":"x"}' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('the CWMP response, fault and reaper paths all settle campaigns', () => {
    const fs = require('fs');
    const acs = fs.readFileSync(require.resolve('../src/services/acsService'), 'utf8');
    const cwmp = fs.readFileSync(require.resolve('../src/services/cwmpSessionService'), 'utf8');
    expect(acs.match(/cpeFirmwareCampaignService'\)\.afterTaskSettled/g)).toHaveLength(2);
    expect(cwmp).toMatch(/cpeFirmwareCampaignService'\)\.afterTaskSettled\(task\)/);
  });
});

test('cancel drops the downloads no CPE has taken, in the organization only', async () => {
  db.query.mockImplementation(async (sql) => (/SELECT \*/.test(sql) ? [[{ id: 5, status: 'cancelled' }]] : [{ affectedRows: 1 }]));
  await svc.cancelCampaign(5, ORG);
  const [sql, params] = db.query.mock.calls.find(([s]) => /DELETE FROM cpe_tasks/.test(s));
  expect(sql).toMatch(/status = 'queued'/);
  expect(params).toEqual([ORG, 5]);
});
