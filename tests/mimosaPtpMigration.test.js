'use strict';
// =============================================================================
// Mimosa PTP profiles and RF rollups (introduced by development migration 463)
// =============================================================================
// The two system Mimosa PTP profiles, their OIDs, and the rollup tiers that
// aggregate ifOperStatus and the RF fields — as an install gets them (the
// baseline's rows and procedures) and as schema.sql mirrors them. 463's
// in-place upgrade of older rows, device reassignment and rollback went with
// the development history.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineRows, baselineProgram } = require('./helpers/baseline');

const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');

const profiles = baselineRows('snmp_profiles');
const profile = name => profiles.find(p => p.name === name);
const liveOids = name => baselineRows('snmp_profile_oids')
  .filter(o => o.profile_id === profile(name).id && o.deleted_at === null);

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function schemaSeedBlock(profileName) {
  const insert = /INSERT(?: IGNORE)? INTO snmp_profile_oids/g;
  let match;
  while ((match = insert.exec(schema))) {
    const statement = schema.slice(match.index, schema.indexOf(';', match.index) + 1);
    if (statement.includes(`p.name = '${profileName}'`)) return statement;
  }
  throw new Error(`No OID seed statement found for ${profileName}`);
}

function schemaProcedure(name) {
  let start = schema.indexOf(`CREATE PROCEDURE ${name}()`);
  if (start === -1) start = schema.indexOf(`CREATE PROCEDURE IF NOT EXISTS ${name}()`);
  expect(start).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf('END$$', start) + 5);
}

const PTP = ['Mimosa B-series PTP', 'Mimosa C5c PTP'];

describe('Mimosa PTP profiles and RF rollups', () => {
  test('ships both PTP profiles as global system profiles with explicit PTP metadata', () => {
    expect(profile('Mimosa B-series PTP')).toMatchObject({ organization_id: null, is_system: 1, model_pattern: 'B%', device_type: 'ptp' });
    expect(profile('Mimosa C5c PTP')).toMatchObject({ organization_id: null, is_system: 1, model_pattern: '%C5c%', device_type: 'ptp' });
    expect(profile('Mimosa Networks')).toBeUndefined();
    for (const name of PTP) {
      expect(schema).toMatch(new RegExp(
        `WHERE NOT EXISTS \\([\\s\\S]*organization_id IS NULL[\\s\\S]*is_system = TRUE[\\s\\S]*name = '${name}'[\\s\\S]*deleted_at IS NULL`,
      ));
    }
  });

  test('polls one Counter64 source per direction, never the 32-bit counters', () => {
    for (const name of PTP) {
      const oids = liveOids(name);
      const byOid = oid => oids.filter(o => o.oid === oid);
      expect(byOid('1.3.6.1.2.1.31.1.1.1.6')).toEqual([expect.objectContaining({ metric_column: 'if_in_octets', oid_type: 'counter64' })]);
      expect(byOid('1.3.6.1.2.1.31.1.1.1.10')).toEqual([expect.objectContaining({ metric_column: 'if_out_octets', oid_type: 'counter64' })]);
      expect(oids.filter(o => ['if_in_octets', 'if_out_octets'].includes(o.metric_column))).toHaveLength(2);
      expect(byOid('1.3.6.1.2.1.2.2.1.10')).toEqual([]);
      expect(byOid('1.3.6.1.2.1.2.2.1.16')).toEqual([]);

      const seed = schemaSeedBlock(name);
      expect(occurrences(seed, "'if_in_octets'")).toBe(1);
      expect(occurrences(seed, "'if_out_octets'")).toBe(1);
      expect(occurrences(seed, "'counter64'")).toBe(2);
      expect(seed).not.toContain("'1.3.6.1.2.1.2.2.1.10'");
      expect(seed).not.toContain("'1.3.6.1.2.1.2.2.1.16'");
    }
  });

  test('uses the verified Mimosa values, scaling, and chain-1 RF instances', () => {
    for (const name of PTP) {
      const oids = liveOids(name);
      const has = oid => oids.some(o => o.oid === oid);
      for (const oid of [
        '1.3.6.1.2.1.1.3.0', '1.3.6.1.4.1.43356.2.1.2.1.8.0', '1.3.6.1.4.1.43356.2.1.2.6.6.0',
        '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1', '1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1',
        '1.3.6.1.4.1.43356.2.1.2.7.1.0', '1.3.6.1.4.1.43356.2.1.2.7.2.0',
      ]) expect(has(oid)).toBe(true);
      expect(oids.filter(o => o.transform === 'value / 10')).toHaveLength(4);
      expect(oids.filter(o => o.transform === 'value / 100000')).toHaveLength(2);
      expect(oids.some(o => o.metric_column === 'tx_power_dbm')).toBe(false);
      expect(oids.some(o => o.oid.startsWith('1.3.6.1.4.1.43356.2.1.2.6.1.6'))).toBe(false);
      expect(oids.find(o => o.oid === '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1'))
        .toMatchObject({ metric_column: 'noise_floor_dbm', label: 'Mimosa RF Chain 1 Noise (dBm)', is_per_interface: 0, aggregate: 0 });
      expect(oids.find(o => o.oid === '1.3.6.1.4.1.43356.2.1.2.6.1.1.5.1'))
        .toMatchObject({ metric_column: 'snr_db', label: 'Mimosa RF Chain 1 SNR (dB)', is_per_interface: 0, aggregate: 0 });
    }
  });

  test('the bad enterprise rows are retired, not live', () => {
    const badOids = [
      '1.3.6.1.4.1.43356.2.1.1.1.1', '1.3.6.1.4.1.43356.2.1.2.1.1.1', '1.3.6.1.4.1.43356.2.1.2.1.1.2',
      '1.3.6.1.4.1.43356.2.1.2.1.1.3', '1.3.6.1.4.1.43356.2.1.2.1.1.4', '1.3.6.1.4.1.43356.2.1.2.1.1.7',
      '1.3.6.1.4.1.43356.2.1.2.1.1.8', '1.3.6.1.4.1.43356.2.1.2.1.1.10', '1.3.6.1.4.1.43356.2.1.2.1.1.11',
    ];
    const live = baselineRows('snmp_profile_oids').filter(o => o.deleted_at === null).map(o => o.oid);
    for (const oid of badOids) expect(live).not.toContain(oid);
  });

  test('aggregates ifOperStatus and every existing RF field at all three tiers', () => {
    const fields = [
      'if_oper_status', 'noise_floor_dbm', 'air_util_pct', 'gps_sync_status',
      'snr_db', 'ccq_pct', 'tx_rate_mbps', 'rx_rate_mbps',
    ];
    for (const tier of ['1hr', '1day', '1month']) {
      for (const body of [baselineProgram('procedure', `snmp_rollup_to_${tier}`), schemaProcedure(`snmp_rollup_to_${tier}`)]) {
        for (const field of fields) {
          expect(body).toContain(`avg_${field}`);
          expect(body).toContain(`min_${field}`);
          expect(body).toContain(`max_${field}`);
        }
      }
    }
    expect(baselineRows('snmp_rollup_state').map(r => r.rollup_name)).toContain('1month');
    expect(schema).toMatch(/\('1month', NULL\)/);
    expect(schema).toMatch(/CREATE EVENT IF NOT EXISTS evt_snmp_rollup_1month[\s\S]*DO CALL snmp_rollup_to_1month\(\)/);
  });
});
