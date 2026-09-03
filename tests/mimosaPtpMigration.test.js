'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('database/migrations/463_mimosa_ptp_profiles_and_rf_rollups.sql');
const rollback = read('database/rollbacks/463_mimosa_ptp_profiles_and_rf_rollups.sql');
const schema = read('database/schema.sql');

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function oidSeedBlock(source, profileName) {
  const insert = /INSERT(?: IGNORE)? INTO snmp_profile_oids/g;
  let match;
  while ((match = insert.exec(source))) {
    const semicolon = source.indexOf(';', match.index);
    expect(semicolon).toBeGreaterThan(match.index);
    const statement = source.slice(match.index, semicolon + 1);
    if (statement.includes(`p.name = '${profileName}'`)) return statement;
  }
  throw new Error(`No OID seed statement found for ${profileName}`);
}

function procedureBody(source, name) {
  let start = source.indexOf(`CREATE PROCEDURE ${name}()`);
  if (start === -1) {
    start = source.indexOf(`CREATE PROCEDURE IF NOT EXISTS ${name}()`);
  }
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('END$$', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 5);
}

describe('migration 463 Mimosa PTP profiles and RF rollups', () => {
  test('renames only the global system legacy profile and keeps explicit PTP metadata', () => {
    expect(migration).toMatch(
      /WHERE organization_id IS NULL[\s\S]*is_system = TRUE[\s\S]*name = 'Mimosa Networks'[\s\S]*deleted_at IS NULL/,
    );
    expect(migration).toMatch(
      /SET name = 'Mimosa B-series PTP'[\s\S]*model_pattern = 'B%'[\s\S]*device_type = 'ptp'/,
    );
    expect(migration).toMatch(
      /'Mimosa C5c PTP', 'Mimosa', '%C5c%', 'ptp'/,
    );

    for (const name of ['Mimosa B-series PTP', 'Mimosa C5c PTP']) {
      expect(migration).toMatch(new RegExp(
        `WHERE NOT EXISTS \\([\\s\\S]*organization_id IS NULL[\\s\\S]*is_system = TRUE[\\s\\S]*name = '${name}'[\\s\\S]*deleted_at IS NULL`,
      ));
      expect(schema).toMatch(new RegExp(
        `WHERE NOT EXISTS \\([\\s\\S]*organization_id IS NULL[\\s\\S]*is_system = TRUE[\\s\\S]*name = '${name}'[\\s\\S]*deleted_at IS NULL`,
      ));
    }

    const vendorSeeds = schema.slice(
      schema.indexOf('-- Seed: \u00a79.1 new vendor snmp_profiles'),
      schema.indexOf('-- Mimosa B-series PTP OIDs'),
    );
    expect(vendorSeeds).not.toContain('INSERT IGNORE INTO snmp_profiles');
  });

  test('upgrades legacy traffic rows and seeds one Counter64 source per direction', () => {
    expect(migration).toMatch(
      /SET spo\.oid = '1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.6'[\s\S]*spo\.oid = '1\.3\.6\.1\.2\.1\.2\.2\.1\.10'/,
    );
    expect(migration).toMatch(
      /SET spo\.oid = '1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.10'[\s\S]*spo\.oid = '1\.3\.6\.1\.2\.1\.2\.2\.1\.16'/,
    );

    for (const source of [migration, schema]) {
      for (const name of ['Mimosa B-series PTP', 'Mimosa C5c PTP']) {
        const seed = oidSeedBlock(source, name);
        expect(occurrences(seed, "'if_in_octets'")).toBe(1);
        expect(occurrences(seed, "'if_out_octets'")).toBe(1);
        expect(seed).toContain("'1.3.6.1.2.1.31.1.1.1.6'");
        expect(seed).toContain("'1.3.6.1.2.1.31.1.1.1.10'");
        expect(occurrences(seed, "'counter64'")).toBe(2);
        expect(seed).not.toContain("'1.3.6.1.2.1.2.2.1.10'");
        expect(seed).not.toContain("'1.3.6.1.2.1.2.2.1.16'");
      }
    }

    // A partial run with both widths is repaired after the guarded inserts.
    expect(migration).toMatch(
      /legacy\.oid = '1\.3\.6\.1\.2\.1\.2\.2\.1\.10'[\s\S]*hc\.oid = '1\.3\.6\.1\.2\.1\.31\.1\.1\.1\.6'/,
    );
  });

  test('uses the verified Mimosa values, scaling, and chain-1 RF instances', () => {
    for (const source of [migration, schema]) {
      const b = oidSeedBlock(source, 'Mimosa B-series PTP');
      const c = oidSeedBlock(source, 'Mimosa C5c PTP');

      for (const seed of [b, c]) {
        expect(seed).toContain("'1.3.6.1.2.1.1.3.0'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.1.8.0'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.6.6.0'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.7.1.0'");
        expect(seed).toContain("'1.3.6.1.4.1.43356.2.1.2.7.2.0'");
        expect(occurrences(seed, "'value / 10'")).toBe(4);
        expect(occurrences(seed, "'value / 100000'")).toBe(2);
        expect(seed).not.toContain('tx_power_dbm');
        expect(seed).not.toContain('1.3.6.1.4.1.43356.2.1.2.6.1.6');
      }

      expect(c).toMatch(
        /6\.1\.1\.4\.1'[\s\S]*'noise_floor_dbm'[\s\S]*'Mimosa RF Chain 1 Noise \(dBm\)'[\s\S]*FALSE[\s\S]*FALSE[\s\S]*'value \/ 10'/,
      );
      expect(c).toMatch(
        /6\.1\.1\.5\.1'[\s\S]*'snr_db'[\s\S]*'Mimosa RF Chain 1 SNR \(dB\)'[\s\S]*FALSE[\s\S]*FALSE[\s\S]*'value \/ 10'/,
      );
    }
  });

  test('retires only the enumerated bad enterprise rows on the tenant-safe profile', () => {
    const badOids = [
      '1.3.6.1.4.1.43356.2.1.1.1.1',
      '1.3.6.1.4.1.43356.2.1.2.1.1.1',
      '1.3.6.1.4.1.43356.2.1.2.1.1.2',
      '1.3.6.1.4.1.43356.2.1.2.1.1.3',
      '1.3.6.1.4.1.43356.2.1.2.1.1.4',
      '1.3.6.1.4.1.43356.2.1.2.1.1.7',
      '1.3.6.1.4.1.43356.2.1.2.1.1.8',
      '1.3.6.1.4.1.43356.2.1.2.1.1.10',
      '1.3.6.1.4.1.43356.2.1.2.1.1.11',
    ];
    const retirement = migration.slice(
      migration.indexOf('UPDATE snmp_profile_oids spo', migration.indexOf('-- Part 2')),
      migration.indexOf('-- Upgrade the two legacy standard rows'),
    );
    expect(retirement).toMatch(/p\.organization_id IS NULL[\s\S]*p\.is_system = TRUE/);
    expect(retirement).not.toMatch(/oid LIKE\s+'1\.3\.6\.1\.4\.1\.43356/);
    for (const oid of badOids) expect(retirement).toContain(`'${oid}'`);
  });

  test('moves only assigned C5c PTP/backhaul devices and rollback preserves references', () => {
    expect(migration).toMatch(
      /SET snmp_profile_id = v_c_profile_id[\s\S]*snmp_profile_id = v_b_profile_id[\s\S]*\(type = 'ptp' OR role = 'backhaul'\)[\s\S]*LIKE '%c5c%'/,
    );
    expect(migration).toMatch(
      /SET suggested_profile_id = v_c_profile_id[\s\S]*suggested_profile_id = v_b_profile_id[\s\S]*device_type = 'ptp'[\s\S]*LIKE '%c5c%'/,
    );

    const deviceMove = rollback.indexOf('SET d.snmp_profile_id = v_b_profile_id');
    const discoveryMove = rollback.indexOf('SET dr.suggested_profile_id = v_b_profile_id');
    const deleteC5c = rollback.indexOf('DELETE FROM snmp_profiles');
    expect(deviceMove).toBeGreaterThan(-1);
    expect(discoveryMove).toBeGreaterThan(deviceMove);
    expect(deleteC5c).toBeGreaterThan(discoveryMove);
    expect(rollback).toMatch(
      /SET name = 'Mimosa Networks'[\s\S]*model_pattern = 'A\[2-9\]\|B\[2-9\]\|C\[2-9\]'[\s\S]*device_type = NULL/,
    );
  });

  test('aggregates ifOperStatus and every existing RF field at all three tiers', () => {
    const fields = [
      'if_oper_status',
      'noise_floor_dbm',
      'air_util_pct',
      'gps_sync_status',
      'snr_db',
      'ccq_pct',
      'tx_rate_mbps',
      'rx_rate_mbps',
    ];

    for (const source of [migration, schema]) {
      for (const tier of ['1hr', '1day', '1month']) {
        const body = procedureBody(source, `snmp_rollup_to_${tier}`);
        for (const field of fields) {
          expect(body).toContain(`avg_${field}`);
          expect(body).toContain(`min_${field}`);
          expect(body).toContain(`max_${field}`);
        }
      }
    }

    expect(schema).toMatch(/\('1month', NULL\)/);
    expect(schema).toMatch(
      /CREATE EVENT IF NOT EXISTS evt_snmp_rollup_1month[\s\S]*DO CALL snmp_rollup_to_1month\(\)/,
    );
  });

  test('ships a same-number rollback with pre-463 traffic and rollup semantics', () => {
    expect(rollback).toMatch(
      /SET spo\.oid = '1\.3\.6\.1\.2\.1\.2\.2\.1\.10'[\s\S]*spo\.oid_type = 'counter'/,
    );
    expect(rollback).toMatch(
      /SET spo\.oid = '1\.3\.6\.1\.2\.1\.2\.2\.1\.16'[\s\S]*spo\.oid_type = 'counter'/,
    );
    expect(rollback).toContain('CREATE PROCEDURE snmp_rollup_to_1hr()');
    expect(rollback).toContain('CREATE PROCEDURE snmp_rollup_to_1day()');
    expect(rollback).toContain('CREATE PROCEDURE snmp_rollup_to_1month()');
  });
});
