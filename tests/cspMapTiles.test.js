// =============================================================================
// FE-11 / SEC-15 — the CSP lets map tiles and the API docs load
// =============================================================================
// Every response carried img-src 'self' data:, so Leaflet's cross-origin tile
// images (OpenStreetMap or the configured map_tile_url) were blocked and every
// map was grey in production. script-src 'self' also blanked /api/docs, which
// loads Swagger UI from unpkg plus an inline bootstrap script.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const request = require('supertest');
const db = require('../src/config/database');
const tiles = require('../src/utils/mapTileOrigins');
const app = require('../src/app');

const directive = (csp, name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '');

describe('tileOrigin', () => {
  test.each([
    ['https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://*.tile.openstreetmap.org'],
    ['https://tiles.example.mx/styles/{z}/{x}/{y}.png?key=1', 'https://tiles.example.mx'],
    ['http://10.0.0.5:8080/{z}/{x}/{y}.png', 'http://10.0.0.5:8080'],
    ['javascript:alert(1)', null],
    ["https://evil.example; script-src *", null],
    ['https://user@tiles.example.mx/{z}.png', null],
    ['', null],
  ])('%s → %s', (template, expected) => {
    expect(tiles.tileOrigin(template)).toBe(expected);
  });
});

test('img-src allows the OpenStreetMap tile servers by default', async () => {
  const res = await request(app).get('/api/health');
  expect(directive(res.headers['content-security-policy'], 'img-src')).toMatch(/https:\/\/\*\.tile\.openstreetmap\.org/);
});

test('img-src follows the configured tile server once it is loaded', async () => {
  db.query.mockResolvedValueOnce([[{ setting_value: 'https://tiles.example.mx/{z}/{x}/{y}.png' }]]);
  await tiles.loadMapTileOrigins();
  const res = await request(app).get('/api/health');
  const img = directive(res.headers['content-security-policy'], 'img-src');
  expect(img).toMatch(/https:\/\/tiles\.example\.mx/);
  expect(img).toMatch(/\*\.tile\.openstreetmap\.org/);
});

test('/api/docs gets a policy that runs Swagger UI, with a nonce for its inline script', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  const csp = res.headers['content-security-policy'];
  const script = directive(csp, 'script-src');
  expect(script).toMatch(/https:\/\/unpkg\.com/);
  const nonce = script.match(/'nonce-([^']+)'/)[1];
  expect(res.text).toContain(`<script nonce="${nonce}">SwaggerUIBundle(`);
  expect(res.text).toMatch(/swagger-ui-dist@\d+\.\d+\.\d+\//); // pinned, not a floating range
  expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
});
