'use strict';
// =============================================================================
// VigaBSS 5.0 — GET /portal/legal-info (migration 449)
// =============================================================================
// The portal footer's Carta de Derechos link: MX clients get the org's
// configured URL or the official IFT document; the locale travels with it so
// the footer only renders the link for MX subscribers.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.access.token'),
  verify: jest.fn(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const jwt = require('jsonwebtoken');
const app = require('../src/app');

beforeEach(() => jest.clearAllMocks());

function wire({ client, cartaUrl, orgName }) {
  jwt.verify.mockReturnValue({ sub: 1, orgId: client.organization_id, type: 'portal' });
  db.query.mockImplementation((sql) => {
    // portalAuthenticate's identity lookup (no locale column — that omission
    // is exactly why the endpoint reads locale itself; this test caught it).
    if (/SELECT id, organization_id, name, email, status(, portal_token_version)? FROM clients/.test(sql)) {
      return Promise.resolve([[{ id: client.id, organization_id: client.organization_id, name: client.name, email: client.email, status: client.status }]]);
    }
    if (/LEFT JOIN organization_mx_profiles/.test(sql)) {
      return Promise.resolve([[{ locale: client.locale, carta_derechos_url: cartaUrl ?? null, organization_name: orgName ?? null }]]);
    }
    return Promise.resolve([[]]);
  });
}

const MX_CLIENT = { id: 1, organization_id: 5, name: 'María', email: 'm@x.mx', status: 'active', locale: 'MX' };

it('returns the org-configured Carta URL for an MX client', async () => {
  wire({ client: MX_CLIENT, cartaUrl: 'https://mx-isp.example/carta.pdf' });
  const res = await request(app)
    .get('/api/v1/portal/legal-info')
    .set('Authorization', 'Bearer portal.valid');
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ locale: 'MX', carta_derechos_url: 'https://mx-isp.example/carta.pdf', organization_name: null });
});

it('falls back to the official IFT document when the org has none configured', async () => {
  wire({ client: MX_CLIENT, cartaUrl: null });
  const res = await request(app)
    .get('/api/v1/portal/legal-info')
    .set('Authorization', 'Bearer portal.valid');
  expect(res.status).toBe(200);
  expect(res.body.data.carta_derechos_url).toMatch(/^https:\/\/www\.ift\.org\.mx\//);
});

it('a global client gets locale global — the footer link stays hidden', async () => {
  wire({ client: { ...MX_CLIENT, locale: 'global', organization_id: 1 }, cartaUrl: undefined });
  const res = await request(app)
    .get('/api/v1/portal/legal-info')
    .set('Authorization', 'Bearer portal.valid');
  expect(res.status).toBe(200);
  expect(res.body.data.locale).toBe('global');
});

it('carries the company name for the browser tab', async () => {
  wire({ client: MX_CLIENT, cartaUrl: null, orgName: 'Red Norte' });
  const res = await request(app)
    .get('/api/v1/portal/legal-info')
    .set('Authorization', 'Bearer portal.valid');
  expect(res.status).toBe(200);
  expect(res.body.data.organization_name).toBe('Red Norte');
});

describe('GET /portal/brand (no sign-in)', () => {
  function orgs(names, { logo = false } = {}) {
    db.query.mockImplementation((sql) => {
      if (/FROM organizations/.test(sql)) return Promise.resolve([names.map((name, i) => ({ id: i + 1, name }))]);
      if (/FROM files/.test(sql) && logo) return Promise.resolve([[{ id: 9, file_name: 'l.png', file_path: 'organizations/logos/none.png', mime_type: 'image/png' }]]);
      return Promise.resolve([[]]);
    });
  }

  it('names the company when the installation serves exactly one', async () => {
    orgs(['Red Norte']);
    const res = await request(app).get('/api/v1/portal/brand');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ organization_name: 'Red Norte', has_logo: false });
  });

  it('names nobody when there are several companies', async () => {
    orgs(['Red Norte', 'Red Sur']);
    const res = await request(app).get('/api/v1/portal/brand');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ organization_name: null, has_logo: false });
  });

  it('says when that one company has a logo', async () => {
    orgs(['Red Norte'], { logo: true });
    const res = await request(app).get('/api/v1/portal/brand');
    expect(res.body.data).toEqual({ organization_name: 'Red Norte', has_logo: true });
  });

  it('gives no logo to anyone when there are several companies', async () => {
    orgs(['Red Norte', 'Red Sur'], { logo: true });
    const res = await request(app).get('/api/v1/portal/brand/logo');
    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /FROM files/.test(sql))).toBe(false);
  });
});

describe('GET /portal/logo (signed-in customer)', () => {
  const fs = require('fs');
  const path = require('path');
  const { STORAGE_ROOT } = require('../src/middleware/upload');
  const rel = path.join('organizations', 'logos', 'portal-logo-test.png');
  const abs = path.join(STORAGE_ROOT, rel);

  beforeAll(() => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]));
  });
  afterAll(() => fs.rmSync(abs, { force: true }));

  function signedIn(orgId, { hasLogo }) {
    jwt.verify.mockReturnValue({ sub: 1, orgId, type: 'portal' });
    db.query.mockImplementation((sql, params) => {
      if (/FROM clients WHERE id/.test(sql)) return Promise.resolve([[{ id: 1, organization_id: orgId, name: 'María', email: 'm@x.mx', status: 'active' }]]);
      // Only the customer's own company has a logo in this test.
      if (/FROM files/.test(sql)) return Promise.resolve([hasLogo && Number(params[0]) === orgId ? [{ id: 2, file_name: 'l.png', file_path: rel, mime_type: 'image/png' }] : []]);
      return Promise.resolve([[]]);
    });
  }

  it('serves the logo of the customer\'s own company', async () => {
    signedIn(5, { hasLogo: true });
    const res = await request(app).get('/api/v1/portal/logo').set('Authorization', 'Bearer portal.valid');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    const lookup = db.query.mock.calls.find(([sql]) => /FROM files/.test(sql));
    expect(lookup[1]).toEqual([5]);
  });

  it('answers 404 when the company has none', async () => {
    signedIn(5, { hasLogo: false });
    const res = await request(app).get('/api/v1/portal/logo').set('Authorization', 'Bearer portal.valid');
    expect(res.status).toBe(404);
  });

  it('needs a portal session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('bad token'); });
    const res = await request(app).get('/api/v1/portal/logo');
    expect(res.status).toBe(401);
  });
});
