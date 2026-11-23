'use strict';
// A PON port can be marked as having a transceiver with an embedded OTDR
// (eOTDR), so measurements are only offered for ports that carry one.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('ports are not eOTDR unless someone marks them', () => {
  expect(read('database', 'migrations', '022_olt_port_eotdr.sql')).toMatch(/ADD COLUMN has_eotdr TINYINT\(1\) NOT NULL DEFAULT 0/);
});

test('the flag can be set when a port is created or changed', () => {
  const { createOltPort, updateOltPort, patchOltPort } = require('../src/middleware/schemas/oltPorts');
  for (const schema of [createOltPort, updateOltPort, patchOltPort]) expect(schema.has_eotdr).toMatchObject({ type: 'boolean' });
  // The port routes write the columns their schema lists.
  expect(read('src', 'routes', 'oltManagement.js')).toMatch(/columnsOf\(createOltPort, 'organization_id', 'olt_device_id'\)/);
});

test('the port form offers it and the list shows it', () => {
  const page = read('frontend', 'src', 'pages', 'OltManagementPage.tsx');
  expect(page).toMatch(/checked=\{Boolean\(form\.has_eotdr\)\}/);
  expect(page).toMatch(/\{Boolean\(Number\(port\.has_eotdr\)\) && \(/);
});
