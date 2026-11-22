// =============================================================================
// VigaBSS 5.0 — PAC environment scoping
// =============================================================================
// Stamping uses ONLY the PAC rows of the install's fiscal environment: a live
// install (INSTALL_MODE unset) is 'production', a test install 'sandbox'
// (src/utils/installMode.js). There is no per-organization choice. A sandbox
// row must never stamp a live invoice, and priority must not let a
// wrong-environment PAC win. A CFDI is cancelled in the environment that
// stamped it. Driven through
// the REAL stack (httpRequest → a stand-in SW server); the db mock honors the
// environment parameter so it mirrors the real WHERE clause.
// =============================================================================

const http = require('http');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const config = require('../src/config');
const cfdiService = require('../src/services/cfdiService');

const DOC = { id: 9, organization_id: 5, uuid: 'AAAAAAAA-0000-4000-8000-AAAAAAAAAAAA', xml_content: '<cfdi:Comprobante Version="4.0"/>', sat_status: 'draft', invoice_id: null };

let sandServer; let prodServer;
beforeAll(async () => {
  sandServer = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { uuid: 'SAND-1', cfdi: '<s/>', selloSAT: 's' } })); });
  prodServer = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: { uuid: 'PROD-1', cfdi: '<s/>', selloSAT: 's' } })); });
  await new Promise(r => sandServer.listen(0, '127.0.0.1', r));
  await new Promise(r => prodServer.listen(0, '127.0.0.1', r));
});
afterAll(async () => { await new Promise(r => sandServer.close(r)); await new Promise(r => prodServer.close(r)); });
const sandBase = () => `http://127.0.0.1:${sandServer.address().port}`;
const prodBase = () => `http://127.0.0.1:${prodServer.address().port}`;

let nextId = 700;
function pac(over) {
  return { id: nextId++, provider_name: 'sw_sapien', seal_mode: 'pac', token_encrypted: 'tok', status: 'active', priority: 100, ...over };
}

// The mock mirrors the real SQL: pac_providers is filtered by params[1] (the
// environment the service scoped the query to). If the service forgot the
// filter, the mock would still hand back only the queried environment — so the
// assertions below turn on which environment the service actually queries AND
// which provider it then selects.
// `installMode` is the install's switch; `storedOrgChoice` is what the
// organization's fiscal profile still holds from before, which must not count.
function wire(installMode, pacs, storedOrgChoice = null) {
  config.install.mode = installMode;
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM cfdi_documents WHERE id/.test(sql)) return [[{ ...DOC, uuid: null }]]; // an unstamped draft (CFD-11)
    if (/FROM organization_mx_profiles/.test(sql)) return [[{ pac_environment: storedOrgChoice }]];
    if (/FROM pac_providers/.test(sql)) {
      const env = params[1];
      return [pacs.filter(p => p.environment === env).map(p => ({ ...p }))];
    }
    if (/cfdi_cancellations/.test(sql)) return [{ insertId: 1 }];
    return [{ affectedRows: 1 }];
  });
}

const originalMode = config.install.mode;
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { config.install.mode = originalMode; });

describe('PAC environment scoping — stamping', () => {
  test('a live install stamps via the production PAC even when a sandbox PAC has lower priority', async () => {
    // Sandbox priority 5 would WIN on priority alone; the env filter must exclude it.
    const sand = pac({ environment: 'sandbox', priority: 5, api_url: sandBase() });
    const prod = pac({ environment: 'production', priority: 10, api_url: prodBase() });
    wire('live', [sand, prod]);
    const res = await cfdiService.stamp(9);
    expect(res).toMatchObject({ uuid: 'PROD-1', status: 'vigente' });
  }, 20000);

  test('a test install stamps via the sandbox PAC', async () => {
    const sand = pac({ environment: 'sandbox', priority: 10, api_url: sandBase() });
    const prod = pac({ environment: 'production', priority: 5, api_url: prodBase() });
    wire('test', [sand, prod]);
    const res = await cfdiService.stamp(9);
    expect(res).toMatchObject({ uuid: 'SAND-1', status: 'vigente' });
  }, 20000);

  test('a live install with only a sandbox PAC stamps nothing: an actionable error, not a silent fallback', async () => {
    const sand = pac({ environment: 'sandbox', priority: 10, api_url: sandBase() });
    wire('live', [sand]);
    await expect(cfdiService.stamp(9)).rejects.toMatchObject({ code: 'CFDI_NO_ACTIVE_PAC' });
  }, 20000);

  test('what an organization chose before the install switch existed does not count', async () => {
    const sand = pac({ environment: 'sandbox', priority: 5, api_url: sandBase() });
    const prod = pac({ environment: 'production', priority: 10, api_url: prodBase() });
    // The profile still says sandbox; a live install stamps in production.
    wire('live', [sand, prod], 'sandbox');
    expect((await cfdiService.stamp(9)).uuid).toBe('PROD-1');
    // And the reverse: a test install never reaches a production PAC.
    wire('test', [sand, prod], 'production');
    expect((await cfdiService.stamp(9)).uuid).toBe('SAND-1');
    expect(db.query.mock.calls.filter(([sql]) => /pac_environment FROM organization_mx_profiles/.test(sql))).toHaveLength(0);
  }, 20000);

  test('an install is live unless it is explicitly test', async () => {
    const sand = pac({ environment: 'sandbox', priority: 10, api_url: sandBase() });
    const prod = pac({ environment: 'production', priority: 5, api_url: prodBase() });
    wire('anything-else', [sand, prod]);
    expect((await cfdiService.stamp(9)).uuid).toBe('PROD-1');
  }, 20000);
});

describe('PAC environment scoping — cancellation', () => {
  test('a live install cancels via the production PAC (sandbox row ignored)', async () => {
    const stampedDoc = { ...DOC, sat_status: 'vigente', serie: 'A', folio: 9, total: '116.00' };
    const sand = pac({ environment: 'sandbox', priority: 5, api_url: sandBase() });
    const prod = pac({ environment: 'production', priority: 10, api_url: prodBase() });
    // SW cancel hits /cfdi33/cancel/... with an acuse; both servers answer, but
    // only the production one must be queried. Capture which server got the call.
    let sandHit = false; let prodHit = false;
    sandServer.removeAllListeners('request');
    prodServer.removeAllListeners('request');
    sandServer.on('request', (req, res) => { sandHit = true; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'success', data: { acuse: '<Acuse><EstatusUUID>201</EstatusUUID></Acuse>', fechaCancelacion: '2026-07-22' } })); });
    prodServer.on('request', (req, res) => { prodHit = true; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'success', data: { acuse: '<Acuse><EstatusUUID>201</EstatusUUID></Acuse>', fechaCancelacion: '2026-07-22' } })); });

    db.query.mockImplementation(async (sql, params) => {
      if (/FROM cfdi_documents WHERE id/.test(sql)) return [[stampedDoc]];
      if (/FROM organization_mx_profiles/.test(sql)) return [[{ rfc: 'EKU9003173C9', razon_social: 'X', regimen_fiscal: '601', codigo_postal_fiscal: '42501' }]];
      // SW cancel now loads the active CSD (sent inline to /cfdi33/cancel/csd).
      if (/FROM csd_certificates/.test(sql)) return [[{ cer_pem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', key_pem_encrypted: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nBBBB\n-----END ENCRYPTED PRIVATE KEY-----', passphrase_encrypted: '12345678a', is_active: 1, status: 'active', valid_to: new Date(Date.now() + 200 * 86400000) }]];
      if (/FROM pac_providers/.test(sql)) return [[sand, prod].filter(p => p.environment === params[1]).map(p => ({ ...p }))];
      if (/cfdi_cancellations/.test(sql)) return [{ insertId: 1 }];
      return [{ affectedRows: 1 }];
    });

    await cfdiService.cancel(9, '02');
    expect(prodHit).toBe(true);
    expect(sandHit).toBe(false);
  }, 20000);
});
