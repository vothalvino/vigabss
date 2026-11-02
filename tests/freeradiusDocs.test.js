// DB-28 — one FreeRADIUS guide: database/freeradius only points at docs/freeradius.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('database/freeradius/README.md is a pointer with no SQL of its own', () => {
  const stale = fs.readFileSync(path.join(root, 'database/freeradius/README.md'), 'utf8');
  expect(stale).toMatch(/docs\/freeradius/);
  expect(stale).not.toMatch(/SELECT|INSERT|read_clients/i);
});

test('docs/freeradius keeps the CoA behaviour that only the old guide described', () => {
  expect(fs.readFileSync(path.join(root, 'docs/freeradius/README.md'), 'utf8')).toMatch(/## CoA and Disconnect/);
});
