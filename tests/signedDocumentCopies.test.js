// =============================================================================
// Signed documents can be read and downloaded: staff from the contract or work
// order, the subscriber from the portal (their own signed documents only)
// =============================================================================
// The activation contract was stored with its evidence but nothing showed it
// again once signed: staff saw "Signed by <name>", and the subscriber had no
// copy of what they signed.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  queryReplica: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const zlib = require('zlib');
const request = require('supertest');
const db = require('../src/config/database');
const inventory = require('./helpers/routeInventory');

inventory.install();
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');
const { GUARD } = require('../src/middleware/routeGuard');
const signedDocumentPdf = require('../src/services/signedDocumentPdf');

const token = signPortalAccessToken({ clientId: 10 }, 900);

function pngDataUrl() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat([0, 1].map(() => Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 0)])));
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const SIGNED = {
  id: 7, organization_id: 1, client_id: 10, template_type: 'activation_contract',
  title: 'Contrato de activación', status: 'signed', signer_name: 'Ana López',
  signed_at: '2026-11-06T18:00:00Z', signed_ip: '203.0.113.9', captured_by: 3,
  rendered_body: '> **PRUEBA — SIN EFECTOS LEGALES**\n\n# Contrato\n\nTexto con **negritas**.\n\n- uno\n- dos\n',
  signature_image: pngDataUrl(), content_sha256: 'a'.repeat(64), evidence_sha256: null,
  mx_contract_environment: 'sandbox', mx_registration_number: null, mx_registered_at: null, mx_template_version: '1.0',
  client_name: 'Ana López', org_locale: 'MX',
};

let documentRows;
beforeEach(() => {
  jest.clearAllMocks();
  documentRows = [SIGNED];
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \? AND deleted_at IS NULL LIMIT 1/.test(sql)) {
      return [[{ id: 10, organization_id: 1, name: 'Ana', email: 'ana@x.mx', status: 'active', portal_token_version: 0 }]];
    }
    if (/FROM signed_documents/.test(sql)) return [documentRows];
    return [[]];
  });
});

const documentCalls = () => db.query.mock.calls.filter(([sql]) => /FROM signed_documents/.test(sql));

describe('portal: the subscriber reads and downloads their own signed documents', () => {
  test('the list is the subscriber’s signed documents only', async () => {
    const res = await request(app).get('/api/v1/portal/documents').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const [sql, params] = documentCalls()[0];
    expect(sql).toMatch(/client_id = \?/);
    expect(sql).toMatch(/organization_id <=> \?/);
    expect(sql).toMatch(/status = 'signed'/);
    expect(params).toEqual([10, 1]);
  });

  test('a document shows the signed text and signature, not internal capture details', async () => {
    const res = await request(app).get('/api/v1/portal/documents/7').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 7, title: 'Contrato de activación', signer_name: 'Ana López' });
    expect(res.body.data.rendered_body).toContain('SIN EFECTOS LEGALES');
    expect(res.body.data.signature_image).toMatch(/^data:image\/png;base64,/);
    expect(res.body.data).not.toHaveProperty('signed_ip');
    expect(res.body.data).not.toHaveProperty('captured_by');
    expect(res.body.data).toHaveProperty('evidence_valid');
    const [sql, params] = documentCalls()[0];
    expect(sql).toMatch(/client_id = \?/);
    expect(params).toEqual(['7', 10, 1]);
  });

  test('another subscriber’s or an unsigned document is not found', async () => {
    documentRows = [];
    for (const path of ['/api/v1/portal/documents/8', '/api/v1/portal/documents/8/pdf']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    }
  });

  test('the PDF download is the subscriber’s signed copy', async () => {
    const res = await request(app).get('/api/v1/portal/documents/7/pdf').set('Authorization', `Bearer ${token}`)
      .buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="contrato-de-activacion-7.pdf"');
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    const [sql, params] = documentCalls()[0];
    expect(sql).toMatch(/d\.client_id = \?/);
    expect(sql).toMatch(/d\.status = 'signed'/);
    expect(params).toEqual(['7', 1, 10]);
  });

  test('the staff signing IP is only on staff copies', async () => {
    const staff = await signedDocumentPdf.generateSignedDocumentPdf(7, { orgId: 1, includeSignerIp: true });
    const portal = await signedDocumentPdf.generateSignedDocumentPdf(7, { orgId: 1, clientId: 10 });
    expect(staff.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(portal.buffer.length).toBeLessThan(staff.buffer.length);
  });
});

test('the staff PDF route requires signed_documents.view', () => {
  const route = inventory.list(app).find(r => r.method === 'GET' && r.path === '/api/v1/signed-documents/:id/pdf');
  expect(route).toBeDefined();
  const guards = route.chain.filter(fn => fn && fn[GUARD]).map(fn => fn[GUARD]);
  expect(guards).toContainEqual(expect.objectContaining({ permissions: ['signed_documents.view'] }));
});
