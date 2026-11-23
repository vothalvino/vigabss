'use strict';
// A subscriber with two services (one unlimited, one with a data allowance)
// got data packs and the allowance for whichever contract the database
// returned first. The portal now prefers the contract whose plan has an
// allowance, which is also what decides whether the Data packs tab is shown.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'portal.js'), 'utf8');
const section = src.slice(src.indexOf('// DATA PACKS (§10.3'), src.indexOf('// §11.1 DASHBOARD'));

test('one lookup serves purchase, my-purchases and allowance', () => {
  expect(section.match(/await dataPackContracts\(req\.client\)/g)).toHaveLength(3);
  expect(section).not.toMatch(/SELECT id FROM contracts/);
});

test('the contract whose plan has a data allowance comes first, scoped to the client and organization', () => {
  const helper = section.slice(section.indexOf('async function dataPackContracts'), section.indexOf('// GET /portal/data-packs — list'));
  expect(helper).toMatch(/c\.client_id = \? AND c\.organization_id <=> \? AND c\.status = 'active' AND c\.deleted_at IS NULL/);
  expect(helper).toMatch(/ORDER BY \(COALESCE\(p\.data_cap_gb, 0\) > 0\) DESC, c\.id ASC\s+LIMIT 1/);
  expect(helper).toMatch(/\[client\.id, client\.organizationId\]/);
});
