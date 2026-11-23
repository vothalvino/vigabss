'use strict';
// =============================================================================
// IP pools belong to an access technology
// =============================================================================
// A pool serves WISP subscribers, FTTH subscribers, or both. A new contract's
// PPPoE account takes a pool of the contract's technology, so fibre and
// wireless subscribers get separate address ranges.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const fs = require('fs');
const path = require('path');
const provisioning = require('../src/services/subscriberProvisioningService');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** ip_pools as a list; answers the pool query the way MySQL would. */
function runnerWith(pools) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (!/FROM ip_pools/.test(sql)) return [[]];
      const [version, tech] = params;
      const org = params.length === 4 ? params[2] : null;
      const rows = pools
        .filter((p) => p.ip_version === version && (p.status ?? 'active') === 'active')
        .filter((p) => p.access_technology === tech || p.access_technology === 'both')
        .filter((p) => org === null || p.organization_id === org || p.organization_id === null)
        .sort((a, b) => (Number(b.access_technology === tech) - Number(a.access_technology === tech)) || (a.id - b.id));
      return [rows.slice(0, 1).map((p) => ({ id: p.id }))];
    },
  };
}

const pool = (id, access_technology, extra = {}) => ({ id, ip_version: '4', organization_id: 3, access_technology, ...extra });

describe('which pool a contract takes', () => {
  const pick = (pools, technology) => provisioning.findActivePool(runnerWith(pools), { ipVersion: '4', organizationId: 3, technology });

  test('a pool of its own technology', async () => {
    const pools = [pool(1, 'wisp'), pool(2, 'ftth')];
    await expect(pick(pools, 'ftth')).resolves.toBe(2);
    await expect(pick(pools, 'wisp')).resolves.toBe(1);
  });

  test('a pool for exactly its technology comes before one that serves both', async () => {
    const pools = [pool(1, 'both'), pool(2, 'ftth')];
    await expect(pick(pools, 'ftth')).resolves.toBe(2);
    await expect(pick(pools, 'wisp')).resolves.toBe(1);
  });

  test('never a pool of the other technology', async () => {
    await expect(pick([pool(1, 'wisp')], 'ftth')).resolves.toBeNull();
    await expect(pick([pool(1, 'ftth')], 'wisp')).resolves.toBeNull();
  });

  test('with no technology given it is a WISP contract', async () => {
    await expect(provisioning.findActivePool(runnerWith([pool(1, 'ftth'), pool(2, 'both')]), { ipVersion: '4', organizationId: 3 })).resolves.toBe(2);
  });

  test('the statement keeps the organization and soft-delete conditions', async () => {
    const runner = runnerWith([pool(1, 'both')]);
    await provisioning.findActivePool(runner, { ipVersion: '6', organizationId: 3, technology: 'ftth' });
    const [sql, params] = runner.calls[0];
    expect(sql).toBe("SELECT id FROM ip_pools WHERE ip_version = ? AND status = 'active' AND deleted_at IS NULL AND access_technology IN (?, 'both') AND (organization_id = ? OR organization_id IS NULL) ORDER BY (access_technology = ?) DESC, id LIMIT 1");
    expect(params).toEqual(['6', 'ftth', 3, 'ftth']);
  });
});

describe('where it is stored and set', () => {
  test('pools default to serving both, so a pool nobody has classified keeps working', () => {
    expect(read('database', 'migrations', '020_ip_pool_technology.sql'))
      .toMatch(/ADD COLUMN access_technology ENUM\('wisp','ftth','both'\) NOT NULL DEFAULT 'both'/);
  });

  test('the model and both validators accept it', () => {
    expect(require('../src/models/IpPool').fillable).toContain('access_technology');
    const rules = Object.values(require('../src/middleware/schemas/ipPools')).filter((s) => s && s.access_technology);
    expect(rules).toHaveLength(2);
    for (const schema of rules) expect(schema.access_technology.enum).toEqual(['wisp', 'ftth', 'both']);
  });

  test('a new PPPoE account and a later IPv6 line both ask for the contract\'s technology', () => {
    const src = read('src', 'services', 'subscriberProvisioningService.js');
    expect(src.match(/findActivePool\(runner, \{ ipVersion: '[46]', organizationId, technology/g)).toHaveLength(3);
    expect(src).not.toMatch(/findActivePool\(runner, \{ ipVersion: '[46]', organizationId \}\)/);
  });

  test('the pool form offers the choice', () => {
    expect(read('frontend', 'src', 'pages', 'IpPoolList.tsx')).toMatch(/body\.access_technology = form\.access_technology \|\| 'both';/);
  });
});
