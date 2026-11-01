// =============================================================================
// FE2-06 — the AP-sector form sends what the table and validator accept
// =============================================================================
// The form seeded status:'active' (ap_sector_configs has no status column),
// offered wpa2_enterprise/wpa3_enterprise (the validator allows
// none|wpa2|wpa3|mixed) and the clients panel read client_mac, ccq_percent
// and last_seen while the API returns mac_address, ccq_pct and last_seen_at.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { createApSectorConfig } = require('../src/middleware/schemas/wirelessSectors');

const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'pages', 'WirelessManagementPage.tsx'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
const table = (name) => schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\) ENGINE`))[1];

test('the encryption options are exactly the validator enum', () => {
  const options = JSON.parse(page.match(/const ENCRYPTION_OPTIONS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  expect(options.sort()).toEqual([...createApSectorConfig.encryption.enum].sort());
});

test('the sector form does not send a status the table lacks', () => {
  expect(table('ap_sector_configs')).not.toMatch(/^\s+status\s/m);
  const body = page.slice(page.indexOf('interface ApSectorBody'), page.indexOf('}', page.indexOf('interface ApSectorBody')));
  expect(body).not.toMatch(/status/);
  expect(page).not.toMatch(/encryption: 'none', status:/);
});

test('the clients panel reads the columns the API returns', () => {
  const stats = table('wireless_client_sessions');
  for (const col of ['mac_address', 'ccq_pct', 'last_seen_at']) {
    expect(stats).toMatch(new RegExp(`^\\s+${col}\\s`, 'm'));
    expect(page).toMatch(new RegExp(`c\\.${col}\\b`));
  }
  expect(page).not.toMatch(/c\.client_mac|c\.ccq_percent|c\.last_seen\)/);
});
