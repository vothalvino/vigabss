'use strict';
// =============================================================================
// A firmware download is done when the CPE has installed it (migration 523)
// =============================================================================
// A TR-069 Download task was 'done' as soon as the CPE answered the Download
// RPC, and a firmware campaign counted that CPE as upgraded. The answer only
// says the CPE accepted (Status 1: it applies the image later) or applied it;
// the transfer could still fail, the CPE's TransferComplete was never
// answered, and nobody checked the version it ran afterwards. Now:
//   - Status 1 waits in 'awaiting_transfer' for the TransferComplete;
//   - TransferComplete fault 0 is done only if the version the CPE reports is
//     the target; a fault, or another version, fails it;
//   - Status 0 is done once the CPE reports the target version;
//   - a download nobody confirms is failed after CPE_TRANSFER_TIMEOUT_HOURS.
// The Inform also stops ignoring the version: TR-069 reports it as the
// DeviceInfo.SoftwareVersion parameter, not in DeviceId.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const svc = require('../src/services/cpeFirmwareCampaignService');
const { parseCwmpEnvelope } = require('../src/services/cwmpXml');

const ORG = 1;
let tasks;
let devices;
let campaignUpdates;

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT software_version FROM cpe_devices WHERE id = \?/.test(s)) {
      return [[devices.find(d => d.id === params[0])].filter(Boolean)];
    }
    if (/^UPDATE cpe_tasks SET status = 'awaiting_transfer', result = \? WHERE id = \? AND organization_id <=> \? AND status = 'in_progress'/.test(s)) {
      const t = tasks.find(x => x.id === params[1] && x.status === 'in_progress');
      if (t) Object.assign(t, { status: 'awaiting_transfer', result: params[0] });
      return [{ affectedRows: t ? 1 : 0 }];
    }
    if (/^UPDATE cpe_tasks SET status = \?, completed_at = NOW\(\), error_message = \?/.test(s)) {
      const hasResult = /, result = \?/.test(s);
      const id = params[hasResult ? 3 : 2];
      const t = tasks.find(x => x.id === id && ['in_progress', 'awaiting_transfer'].includes(x.status));
      if (t) Object.assign(t, { status: params[0], error_message: params[1], ...(hasResult ? { result: params[2] } : {}) });
      return [{ affectedRows: t ? 1 : 0 }];
    }
    if (/^SELECT \* FROM cpe_tasks WHERE id = \? AND cpe_device_id = \? AND organization_id <=> \? AND task_type = 'download'/.test(s)) {
      return [tasks.filter(t => t.id === params[0] && t.cpe_device_id === params[1] && ['in_progress', 'awaiting_transfer'].includes(t.status))];
    }
    if (/^SELECT \* FROM cpe_tasks WHERE cpe_device_id = \? AND organization_id <=> \? AND task_type = 'download' AND status = 'awaiting_transfer'/.test(s)) {
      return [tasks.filter(t => t.cpe_device_id === params[0] && t.status === 'awaiting_transfer')];
    }
    if (/^SELECT id, task_type, parameters, organization_id, cpe_device_id FROM cpe_tasks WHERE organization_id <=> \? AND status = 'awaiting_transfer'/.test(s)) {
      return [tasks.filter(t => t.status === 'awaiting_transfer' && t.stale)];
    }
    if (/^SELECT SUM\(status = 'done'\) AS ok/.test(s)) {
      const mine = tasks.filter(t => JSON.parse(t.parameters)._campaignId === params[1]);
      return [[{
        ok: mine.filter(t => t.status === 'done').length,
        failed: mine.filter(t => t.status === 'failed').length,
        open: mine.filter(t => ['queued', 'in_progress', 'awaiting_transfer'].includes(t.status)).length,
      }]];
    }
    if (/^UPDATE cpe_firmware_campaigns SET completed_devices = \?/.test(s)) {
      campaignUpdates.push({ completed: params[0], failed: params[1], open: params[2] });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`fake db: unhandled SQL: ${s.slice(0, 120)}`);
  });
}

function task(over = {}) {
  const row = {
    id: 12, organization_id: ORG, cpe_device_id: 5, task_type: 'download', status: 'in_progress',
    parameters: JSON.stringify({ url: 'https://fw/hg.bin', _campaignId: 3, _targetVersion: 'V5R020' }),
    result: null, error_message: null, ...over,
  };
  tasks.push(row);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  tasks = [];
  devices = [{ id: 5, software_version: 'V5R019' }];
  campaignUpdates = [];
  wire();
});

describe('a Download answered with Status 1 (applied later)', () => {
  test('waits for the TransferComplete instead of counting as upgraded', async () => {
    const t = task();
    await svc.onDownloadResponse(t, { status: 1 });
    expect(tasks[0].status).toBe('awaiting_transfer');
    expect(JSON.parse(tasks[0].result)).toMatchObject({ download_status: 1 });
    // The campaign is not recounted yet: nothing settled.
    expect(campaignUpdates).toEqual([]);
  });

  test('is done when the TransferComplete succeeds and the CPE reports the target version', async () => {
    task({ status: 'awaiting_transfer', result: JSON.stringify({ download_status: 1 }) });
    devices[0].software_version = 'V5R020';

    expect(await svc.onTransferComplete({ id: 5 }, { commandKey: 'DL-12', faultCode: '0' })).toBe(true);

    expect(tasks[0].status).toBe('done');
    expect(campaignUpdates.at(-1)).toEqual({ completed: 1, failed: 0, open: 0 });
  });

  test('fails when the CPE reports another version after a successful transfer', async () => {
    task({ status: 'awaiting_transfer', result: JSON.stringify({ download_status: 1 }) });

    await svc.onTransferComplete({ id: 5 }, { commandKey: 'DL-12', faultCode: '0' });

    expect(tasks[0]).toMatchObject({ status: 'failed', error_message: 'The CPE reports version V5R019 after the transfer; expected V5R020' });
    expect(campaignUpdates.at(-1)).toEqual({ completed: 0, failed: 1, open: 0 });
  });

  test('fails on a TransferComplete fault', async () => {
    task({ status: 'awaiting_transfer' });

    await svc.onTransferComplete({ id: 5 }, { commandKey: 'DL-12', faultCode: '9010', faultString: 'Download failure' });

    expect(tasks[0]).toMatchObject({ status: 'failed', error_message: 'TransferComplete fault 9010: Download failure' });
  });

  test('ignores a TransferComplete for another CPE\'s or an unknown download', async () => {
    task({ status: 'awaiting_transfer', cpe_device_id: 6 });
    expect(await svc.onTransferComplete({ id: 5 }, { commandKey: 'DL-12', faultCode: '0' })).toBe(false);
    expect(await svc.onTransferComplete({ id: 5 }, { commandKey: 'reboot', faultCode: '0' })).toBe(false);
    expect(tasks[0].status).toBe('awaiting_transfer');
  });
});

describe('a Download answered with Status 0 (applied)', () => {
  test('is done at once when the CPE already reports the target version', async () => {
    devices[0].software_version = 'V5R020';
    await svc.onDownloadResponse(task(), { status: 0 });
    expect(tasks[0].status).toBe('done');
  });

  test('is done at the Inform that reports the target version, and only then', async () => {
    await svc.onDownloadResponse(task(), { status: 0 });
    expect(tasks[0].status).toBe('awaiting_transfer');

    await svc.onInform({ id: 5 }); // not rebooted yet
    expect(tasks[0].status).toBe('awaiting_transfer');

    devices[0].software_version = 'V5R020';
    await svc.onInform({ id: 5 });
    expect(tasks[0].status).toBe('done');
  });

  test('without a target version, a Status 0 answer is enough', async () => {
    await svc.onDownloadResponse(task({ parameters: JSON.stringify({ url: 'x' }) }), { status: 0 });
    expect(tasks[0].status).toBe('done');
  });
});

describe('a download nobody confirms', () => {
  test('fails after the timeout', async () => {
    task({ status: 'awaiting_transfer', stale: true });
    const res = await svc.reapUnconfirmedDownloads(ORG);
    expect(res).toEqual({ reaped: 1 });
    expect(tasks[0]).toMatchObject({ status: 'failed', error_message: 'The CPE did not confirm the upgrade within 24 h' });
    const [, params] = db.query.mock.calls.find(([sql]) => /status = 'awaiting_transfer'\s+AND started_at </.test(sql));
    expect(params).toEqual([ORG, 24]);
  });

  test('keeps the campaign open while a download awaits confirmation', async () => {
    task({ status: 'done', id: 11 });
    task({ status: 'awaiting_transfer', id: 12 });
    await svc.refreshCampaign(3, ORG);
    expect(campaignUpdates.at(-1)).toEqual({ completed: 1, failed: 0, open: 1 });
  });
});

describe('the CWMP messages', () => {
  const envelope = (body) => `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
    <soapenv:Header><cwmp:ID>7</cwmp:ID></soapenv:Header><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

  test('a TransferComplete is parsed with its command key and fault', () => {
    const parsed = parseCwmpEnvelope(envelope(`<cwmp:TransferComplete><CommandKey>DL-12</CommandKey>
      <FaultStruct><FaultCode>9010</FaultCode><FaultString>Download failure</FaultString></FaultStruct>
      <StartTime>2026-11-05T10:00:00Z</StartTime><CompleteTime>2026-11-05T10:05:00Z</CompleteTime></cwmp:TransferComplete>`));
    expect(parsed).toMatchObject({
      messageType: 'TransferComplete',
      payload: { commandKey: 'DL-12', faultCode: '9010', faultString: 'Download failure', completeTime: '2026-11-05T10:05:00Z' },
    });
  });

  test('a DownloadResponse carries its status', () => {
    expect(parseCwmpEnvelope(envelope('<cwmp:DownloadResponse><Status>1</Status></cwmp:DownloadResponse>')).payload).toMatchObject({ status: 1 });
  });

  test('the Inform reports the software version from the DeviceInfo parameter', () => {
    const parsed = parseCwmpEnvelope(envelope(`<cwmp:Inform><DeviceId><Manufacturer>Huawei</Manufacturer><OUI>00E0FC</OUI><SerialNumber>S1</SerialNumber></DeviceId>
      <ParameterList>
        <ParameterValueStruct><Name>InternetGatewayDevice.DeviceInfo.SoftwareVersion</Name><Value>V5R020</Value></ParameterValueStruct>
        <ParameterValueStruct><Name>InternetGatewayDevice.DeviceInfo.HardwareVersion</Name><Value>HW-2</Value></ParameterValueStruct>
      </ParameterList></cwmp:Inform>`));
    expect(parsed.payload.deviceId).toMatchObject({ swVersion: 'V5R020', hwVersion: 'HW-2' });
  });
});
