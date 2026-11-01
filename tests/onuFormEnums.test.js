// =============================================================================
// FE2-07 — the ONU forms send values the validators accept
// =============================================================================
// The new-profile default vlan_mode 'tagged', firmware scope 'full_olt' and
// OMCI wifi_band '2.4GHz'/'5GHz' (and '' for "None") were all rejected with
// 422, and a profile edit re-sent its updated_at.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { createOnuProfile } = require('../src/middleware/schemas/onuProfiles');
const { createOnuFirmwareJob } = require('../src/middleware/schemas/onuFirmwareJobs');
const { createOnuOmciConfig } = require('../src/middleware/schemas/onuOmciConfigs');

const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'pages', 'OnuManagementPage.tsx'), 'utf8');
const listOf = (name) => page.slice(page.indexOf(`const ${name}`), page.indexOf('];', page.indexOf(`const ${name}`)));
const values = (name) => [...listOf(name).matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
const strings = (name) => [...listOf(name).matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('VLAN modes are the validator enum, and the default is one of them', () => {
  expect(strings('VLAN_MODES').sort()).toEqual([...createOnuProfile.vlan_mode.enum].sort());
  const def = page.match(/function openCreate\(\) \{[^}]*vlan_mode: '([^']+)'/)[1];
  expect(createOnuProfile.vlan_mode.enum).toContain(def);
});

test('firmware scopes are accepted values (a whole OLT is olt_device)', () => {
  for (const v of values('SCOPES')) expect(createOnuFirmwareJob.scope.enum).toContain(v);
  expect(values('SCOPES')).toContain('olt_device');
});

test('Wi-Fi bands are the validator enum, and "None" sends no band', () => {
  expect(values('WIFI_BANDS').sort()).toEqual([...createOnuOmciConfig.wifi_band.enum].sort());
  expect(page).toMatch(/wifi_band: e\.target\.value \|\| undefined/);
});

test('a profile edit leaves out read-only columns', () => {
  for (const col of ['id', 'organization_id', 'created_at', 'updated_at', 'deleted_at']) {
    expect(listOf('PROFILE_READ_ONLY')).toContain(`'${col}'`);
  }
  expect(page).not.toMatch(/setForm\(\{ \.\.\.p \}\)/);
});
