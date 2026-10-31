// =============================================================================
// OPS-05 — the shipped proxies accept every body the app accepts
// =============================================================================
// nginx.conf and host-nginx.conf set no client_max_body_size, so nginx's 1m
// default refused every upload over 1 MiB with 413 (the app takes 20 MB
// files and 10 MB JSON), and the Kubernetes ingress stopped at 10m.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { MAX_FILE_SIZE } = require('../src/middleware/upload');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const UNITS = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const bytes = (value) => {
  const m = /^(\d+)([kmg])?$/i.exec(String(value).trim());
  if (!m) throw new Error(`unparseable size ${value}`);
  return Number(m[1]) * (m[2] ? UNITS[m[2].toLowerCase()] : 1);
};
// A 20 MB file plus multipart framing and the other form fields.
const NEEDED = MAX_FILE_SIZE + 1024 * 1024;
const JSON_LIMIT = 10 * 1024 * 1024; // app.js express.json limit

/** client_max_body_size of the server block that listens on 443. */
function httpsBodyLimit(conf) {
  const server = conf.slice(conf.indexOf('listen      443'));
  const m = /^\s*client_max_body_size\s+(\S+);/m.exec(server.slice(0, server.indexOf('location')));
  return m ? bytes(m[1]) : bytes('1m'); // nginx default
}

test.each(['nginx/nginx.conf', 'nginx/host-nginx.conf'])('%s lets a full-size upload through', (file) => {
  const limit = httpsBodyLimit(read(file));
  expect(limit).toBeGreaterThanOrEqual(NEEDED);
  expect(limit).toBeGreaterThanOrEqual(JSON_LIMIT);
});

test.each(['nginx/nginx.conf', 'nginx/host-nginx.conf'])('%s keeps the small /acs/ body limit', (file) => {
  expect(read(file)).toMatch(/location \/acs\/ \{[^}]*client_max_body_size 1m;/);
});

test.each(['k8s/ingress.yaml', 'charts/fireisp/values.yaml'])('%s ingress body size fits a full-size upload', (file) => {
  const m = /proxy-body-size:\s*"([^"]+)"/.exec(read(file));
  expect(m).not.toBeNull();
  expect(bytes(m[1])).toBeGreaterThanOrEqual(NEEDED);
});
