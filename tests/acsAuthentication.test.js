'use strict';
// =============================================================================
// NET-04 / NET-05 — /acs/cwmp authenticates every message and parses safely
// =============================================================================
// NET-04: with no or a wrong Authorization header, an Inform resolved the CPE
// by serial+OUI alone, so anyone could claim any device (receive its queued
// tasks, adopt an inventory row, overwrite its parameters) or mint unlimited
// devices. Now every message authenticates: a device's own credentials, or
// the ACS-wide credential for first contact by a device with none of its own.
// NET-05: the regex parser was quadratic (100 KB of '<' blocked the event loop
// for ~25 s) and JSON bodies went through the 10 MiB global parser first.
// =============================================================================

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/cwmpSessionService', () => ({
  handleInform: jest.fn().mockResolvedValue({ tasks: [] }),
  getNextTask: jest.fn().mockResolvedValue(null),
  buildResponseForTask: jest.fn().mockReturnValue(null),
  processTaskResponse: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/cpeSessionLogService', () => ({
  logSessionEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/cpeDiagnosticsService', () => ({
  handleDiagnosticsComplete: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/cpeInventoryService', () => ({
  tryAutoLinkSubscriber: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/config/database');
const config = require('../src/config');
const cwmpSessionService = require('../src/services/cwmpSessionService');
const acsService = require('../src/services/acsService');
const { parseCwmpEnvelope } = require('../src/services/cwmpXml');
const app = require('../src/app');

const INFORM = ({ serial = 'SN-1', oui = 'EC1724', params = 1 } = {}) => `<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soapenv:Header><cwmp:ID>1</cwmp:ID></soapenv:Header>
  <soapenv:Body><cwmp:Inform>
    <DeviceId><Manufacturer>Acme</Manufacturer><OUI>${oui}</OUI><ProductClass>X</ProductClass><SerialNumber>${serial}</SerialNumber></DeviceId>
    <Event><EventStruct><EventCode>2 PERIODIC</EventCode><CommandKey></CommandKey></EventStruct></Event>
    <ParameterList>${Array.from({ length: params }, (_, i) =>
    `<ParameterValueStruct><Name>Device.X.${i}</Name><Value>v</Value></ParameterValueStruct>`).join('')}</ParameterList>
  </cwmp:Inform></soapenv:Body>
</soapenv:Envelope>`;

const KNOWN = { id: 5, organization_id: 1, serial_number: 'SN-1', oui: 'EC1724', acs_username: 'cpe5', acs_password_hash: null };
let hash;

beforeAll(async () => {
  hash = await bcrypt.hash('cpe5-pass', 4);
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  acsService.resetAutoRegistrations();
  config.acs.username = 'acs-shared';
  config.acs.password = 'shared-secret';
  config.acs.autoRegistrationsPerHour = 30;
  db.query.mockImplementation(async (sql, params) => {
    if (/WHERE acs_username = \?/.test(sql)) return [params[0] === 'cpe5' ? [{ ...KNOWN, acs_password_hash: hash }] : []];
    if (/serial_number = \? AND oui = \?/.test(sql)) return [params[0] === 'SN-1' ? [{ ...KNOWN }] : []];
    if (/INSERT INTO/i.test(sql)) return [{ insertId: 90, affectedRows: 1 }];
    if (/SELECT \* FROM `?cpe_devices`?.*WHERE.*id/i.test(sql)) return [[{ id: 90, serial_number: 'NEW', oui: 'EC1724' }]];
    return [[]];
  });
});

const cwmp = () => request(app).post('/acs/cwmp').set('Content-Type', 'text/xml');

describe('every CWMP message must authenticate', () => {
  test('an Inform with no credentials is challenged and resolves nothing', async () => {
    const res = await cwmp().send(INFORM());
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect(db.query.mock.calls.some(([sql]) => /serial_number = \?/.test(sql))).toBe(false);
    expect(cwmpSessionService.handleInform).not.toHaveBeenCalled();
  });

  test('a wrong password does not fall through to the serial lookup', async () => {
    const res = await cwmp().auth('cpe5', 'wrong').send(INFORM());
    expect(res.status).toBe(401);
    expect(db.query.mock.calls.some(([sql]) => /serial_number = \?/.test(sql))).toBe(false);
  });

  test("a device's own credentials identify it", async () => {
    const res = await cwmp().auth('cpe5', 'cpe5-pass').send(INFORM());
    expect(res.status).toBe(200);
    expect(cwmpSessionService.handleInform).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), expect.anything(), 1);
  });

  test('the ACS-wide credential cannot claim a device that has its own credentials', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/serial_number = \? AND oui = \?/.test(sql)) return [[{ ...KNOWN, acs_password_hash: hash }]];
      return [[]];
    });
    const res = await cwmp().auth('acs-shared', 'shared-secret').send(INFORM());
    expect(res.status).toBe(401);
    expect(cwmpSessionService.handleInform).not.toHaveBeenCalled();
  });

  test('the ACS-wide credential lets a device without credentials inform', async () => {
    const res = await cwmp().auth('acs-shared', 'shared-secret').send(INFORM());
    expect(res.status).toBe(200);
    expect(cwmpSessionService.handleInform).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), expect.anything(), 1);
  });

  test('inventory adoption by serial only takes rows without credentials', async () => {
    await cwmp().auth('acs-shared', 'shared-secret').send(INFORM({ serial: 'NEW' }));
    const [sql] = db.query.mock.calls.find(([q]) => /oui IS NULL/.test(q));
    expect(sql).toContain('acs_password_hash IS NULL');
  });

  test('without a configured ACS-wide credential an unknown device cannot register', async () => {
    config.acs.username = '';
    config.acs.password = '';
    const res = await cwmp().auth('', '').send(INFORM({ serial: 'NEW' }));
    expect(res.status).toBe(401);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO/i.test(sql))).toBe(false);
  });

  test('a task response under the ACS-wide credential is challenged', async () => {
    const gpv = '<Envelope><Body><GetParameterValuesResponse></GetParameterValuesResponse></Body></Envelope>';
    const res = await cwmp().auth('acs-shared', 'shared-secret').send(gpv);
    expect(res.status).toBe(401);
    expect(cwmpSessionService.processTaskResponse).not.toHaveBeenCalled();
  });

  test('auto-registration is capped per source address', async () => {
    config.acs.autoRegistrationsPerHour = 2;
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await cwmp().auth('acs-shared', 'shared-secret').send(INFORM({ serial: `NEW-${i}` }));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('an Inform with too many parameters is truncated before it is stored', async () => {
    await cwmp().auth('cpe5', 'cpe5-pass').send(INFORM({ params: 300 }));
    const [, payload] = cwmpSessionService.handleInform.mock.calls[0];
    expect(payload.parameters).toHaveLength(256);
  });
});

describe('the CWMP body is bounded and parsed in linear time', () => {
  test('a JSON body is refused with 415 and never parsed', async () => {
    const res = await request(app).post('/acs/cwmp')
      .auth('cpe5', 'cpe5-pass')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(['<'.repeat(1000)]));
    expect(res.status).toBe(415);
    expect(cwmpSessionService.handleInform).not.toHaveBeenCalled();
  });

  test('a body over the ACS limit is refused', async () => {
    const res = await cwmp().auth('cpe5', 'cpe5-pass').send('<'.repeat(600 * 1024));
    expect(res.status).toBe(413);
  });

  test('a DOCTYPE is refused with 400', async () => {
    const res = await cwmp().auth('cpe5', 'cpe5-pass')
      .send('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><Envelope><Body><Inform/></Body></Envelope>');
    expect(res.status).toBe(400);
  });

  test.each([
    ['500 KB of "<"', '<'.repeat(500 * 1024)],
    ['500 KB of unclosed quotes', '<a b="'.repeat(80 * 1024)],
    ['many stray end tags', '</a>'.repeat(120 * 1024)],
  ])('%s parses in well under a second', (_label, body) => {
    const started = process.hrtime.bigint();
    parseCwmpEnvelope(body);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(500);
  });

  test('values are entity-decoded', () => {
    const xml = '<Envelope><Body><GetParameterValuesResponse><ParameterValueStruct><Name>A</Name><Value>x &amp; y &lt;z&gt;</Value></ParameterValueStruct></GetParameterValuesResponse></Body></Envelope>';
    expect(parseCwmpEnvelope(xml).payload.parameterList[0].value).toBe('x & y <z>');
  });
});
