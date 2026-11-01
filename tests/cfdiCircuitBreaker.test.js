// =============================================================================
// VigaBSS 5.0 — CFDI Circuit Breaker Tests
// =============================================================================
// CFD-04: there used to be one process-wide breaker as well as the per-PAC
// ones. Any five stamps that ended without a UUID, from any tenant and for any
// reason, blocked every tenant's stamping for a minute. A PAC answering "the
// receptor RFC is wrong" counted the same as a PAC that was down. The breaker
// is now per PAC row, which belongs to one organization, and only failures of
// the PAC itself count.
// =============================================================================

const http = require('http');

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
}));

const db = require('../src/config/database');
const cfdiService = require('../src/services/cfdiService');

let server; let handler;
beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
const liveBase = () => `http://127.0.0.1:${server.address().port}`;

const json = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const refuse = (res) => json(res, { status: 'error', message: 'CFDI40147 - El RFC del receptor no existe', messageDetail: '' });
const ok = (res) => json(res, { data: { uuid: 'UUID-OK-1', cfdi: '<sealed/>', selloSAT: 's' } });

// sw_sapien with seal_mode 'pac': no CSD or sealing in the way.
const PACS = {
  5: { id: 51, organization_id: 5, provider_name: 'sw_sapien', seal_mode: 'pac', environment: 'sandbox', token_encrypted: 'tok', status: 'active', priority: 1 },
  6: { id: 61, organization_id: 6, provider_name: 'sw_sapien', seal_mode: 'pac', environment: 'sandbox', token_encrypted: 'tok', status: 'active', priority: 1 },
};

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM cfdi_documents WHERE id/.test(sql)) {
      const id = Number(params[0]);
      return [[{ id, organization_id: id < 600 ? 5 : 6, xml_content: '<cfdi:Comprobante Version="4.0"/>', sat_status: 'draft', invoice_id: null }]];
    }
    if (/FROM pac_providers/.test(sql)) return [[{ ...PACS[Number(params[0])], api_url: liveBase() }]];
    if (/pac_environment/.test(sql)) return [[{ pac_environment: 'sandbox' }]];
    return [{ affectedRows: 1 }];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  cfdiService._resetProviderBreakers();
  wire();
});

describe('per-PAC breaker', () => {
  test('is closed by default', () => {
    expect(cfdiService.providerBreaker(51).isOpen()).toBe(false);
  });

  test('opens after the threshold and allows a probe after the reset period', () => {
    const br = cfdiService.providerBreaker(51);
    for (let i = 0; i < br.threshold; i++) br.recordFailure();
    expect(br.isOpen()).toBe(true);
    br.lastFailure = Date.now() - br.resetMs - 1;
    expect(br.isOpen()).toBe(false);
  });

  test('resets after a success', () => {
    const br = cfdiService.providerBreaker(51);
    for (let i = 0; i < 3; i++) br.recordFailure();
    br.recordSuccess();
    expect(br.failures).toBe(0);
  });

  test('a stamp through an open PAC row fails without calling it', async () => {
    const br = cfdiService.providerBreaker(51);
    for (let i = 0; i < br.threshold; i++) br.recordFailure();
    let hit = false;
    handler = (req, res) => { hit = true; ok(res); };
    await expect(cfdiService.stamp(501)).rejects.toThrow(/circuit is open/);
    expect(hit).toBe(false);
  });
});

describe('one tenant cannot block another (CFD-04)', () => {
  test('PAC refusals do not open the circuit', async () => {
    handler = (req, res) => refuse(res);
    for (let i = 0; i < 6; i++) {
      await expect(cfdiService.stamp(501 + i)).rejects.toThrow(/PAC stamping failed/);
    }
    expect(cfdiService.providerBreaker(51).failures).toBe(0);
    handler = (req, res) => ok(res);
    await expect(cfdiService.stamp(510)).resolves.toMatchObject({ uuid: 'UUID-OK-1' });
  });

  test('a PAC failure of one org leaves another org\'s stamping open', async () => {
    // Org 5's PAC answers 500 five times: a failure of the PAC itself.
    handler = (req, res) => { res.statusCode = 500; res.end('boom'); };
    for (let i = 0; i < 5; i++) {
      await expect(cfdiService.stamp(501 + i)).rejects.toThrow(/PAC stamping failed/);
    }
    expect(cfdiService.providerBreaker(51).isOpen()).toBe(true);

    handler = (req, res) => ok(res);
    await expect(cfdiService.stamp(601)).resolves.toMatchObject({ uuid: 'UUID-OK-1', status: 'vigente' });
    await expect(cfdiService.stamp(502)).rejects.toThrow(/circuit is open/);
  });
});
