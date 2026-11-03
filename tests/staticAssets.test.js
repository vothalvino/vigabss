// =============================================================================
// FE-21 — the built SPA is cached and compressed whatever sits in front
// =============================================================================
// express.static served the 3.9 MB bundle uncompressed with max-age=0; only
// the bundled nginx compressed it, so host-nginx and Kubernetes installs sent
// it raw on every load. Hashed assets are now immutable and precompressed.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const { staticAssets } = require('../src/middleware/staticAssets');

let dist;
let app;
const BODY = `console.log(${JSON.stringify('x'.repeat(5000))});`;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), BODY);
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js.gz'), zlib.gzipSync(BODY));
  fs.writeFileSync(path.join(dist, 'assets', 'small-def.css'), 'a{}');
  fs.writeFileSync(path.join(dist, 'secret.txt'), 'outside assets');
  fs.writeFileSync(path.join(dist, 'secret.txt.gz'), zlib.gzipSync('outside assets'));
  const { assets, spa } = staticAssets(dist);
  app = express();
  app.use('/assets', assets);
  app.use(spa);
});

afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

test('a hashed asset is served gzipped to a browser that accepts it, cached as immutable', async () => {
  const res = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'gzip, br');
  expect(res.status).toBe(200);
  expect(res.headers['content-encoding']).toBe('gzip');
  expect(res.headers['content-type']).toMatch(/javascript/);
  expect(res.headers.vary).toMatch(/Accept-Encoding/);
  expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(res.text).toBe(BODY); // supertest inflates it
});

test('without gzip, or with no .gz beside it, the plain file is served, still immutable', async () => {
  const plain = await request(app).get('/assets/index-abc123.js').set('Accept-Encoding', 'identity');
  expect(plain.headers['content-encoding']).toBeUndefined();
  expect(plain.text).toBe(BODY);
  expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');

  const small = await request(app).get('/assets/small-def.css').set('Accept-Encoding', 'gzip');
  expect(small.headers['content-encoding']).toBeUndefined();
  expect(small.text).toBe('a{}');
});

test('index.html is revalidated on every load so a deploy is picked up', async () => {
  const res = await request(app).get('/index.html');
  expect(res.headers['cache-control']).toBe('no-cache');
});

test('the gzip lookup never leaves assets/', async () => {
  const res = await request(app).get('/assets/..%2Fsecret.txt').set('Accept-Encoding', 'gzip');
  expect(res.headers['content-encoding']).toBeUndefined();
});

test('app.js mounts it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  expect(src).toMatch(/app\.use\('\/assets', frontendAssets\.assets\);\napp\.use\(frontendAssets\.spa\);/);
});
