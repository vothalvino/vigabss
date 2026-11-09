// =============================================================================
// Sign-in auditing and blocked IPs (migration 013)
// =============================================================================
// services/loginSecurityService.js counts each failed sign-in against its IP
// and blocks the IP at LOGIN_IP_BLOCK_THRESHOLD, for longer each time it
// returns; middleware/loginIpGuard.js refuses a blocked IP at every sign-in
// route; utils/auditActions.js gives every audit action a category for the
// audit page's filter.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withPrimaryContext: jest.fn((fn) => fn()),
}));
jest.mock('../src/services/auditLog', () => ({ log: jest.fn(async () => {}) }));
jest.mock('../src/services/cacheService', () => ({ incrementFixedWindow: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const auditLog = require('../src/services/auditLog');
const cache = require('../src/services/cacheService');
const config = require('../src/config');
const ls = require('../src/services/loginSecurityService');
const { loginIpGuard } = require('../src/middleware/loginIpGuard');
const { categoryOf, CATEGORIES } = require('../src/utils/auditActions');

const PUBLIC_IP = '203.0.113.7';

function fakeDb({ active = null, previousBlocks = 0 } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM login_ip_blocks\s+WHERE ip_address = \? AND lifted_at IS NULL/.test(sql)) return [active ? [active] : []];
    if (/SELECT COUNT\(\*\) AS n FROM login_ip_blocks/.test(sql)) return [[{ n: previousBlocks }]];
    if (/INSERT INTO login_ip_blocks/.test(sql)) return [{ insertId: 41 }];
    if (/SELECT \* FROM login_ip_blocks WHERE id = \?/.test(sql)) {
      return [[{ id: 41, ip_address: params[0] === 41 ? PUBLIC_IP : PUBLIC_IP, source: 'auto', blocked_until: '2026-11-09 10:00:00' }]];
    }
    return [[]];
  });
  return calls;
}

beforeEach(() => {
  jest.clearAllMocks();
  ls._blockCache.clear();
  config.loginIpBlock = { enabled: true, threshold: 20, windowMinutes: 60, hours: 24, exempt: [] };
});

describe('addresses that are never blocked', () => {
  test.each([
    ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false],
    ['192.168.1.10', true], ['127.0.0.1', true], ['169.254.1.1', true], ['100.64.0.1', true],
    ['100.128.0.1', false], ['::1', true], ['fd00::1', true], ['fe80::1', true],
    [PUBLIC_IP, false], ['2001:db8::1', false], ['not-an-ip', true],
  ])('%s private=%s', (ip, expected) => {
    expect(ls.isPrivateAddress(ip)).toBe(expected);
  });

  test('the exempt list and an empty IP are exempt', () => {
    config.loginIpBlock.exempt = [PUBLIC_IP];
    expect(ls.isExempt(PUBLIC_IP)).toBe(true);
    expect(ls.isExempt('')).toBe(true);
    expect(ls.isExempt('198.51.100.1')).toBe(false);
  });

  test('an IPv4-mapped IPv6 address is read as IPv4', () => {
    expect(ls.clientIp({ ip: `::ffff:${PUBLIC_IP}` })).toBe(PUBLIC_IP);
    expect(ls.requestContext({ ip: PUBLIC_IP, get: () => 'x'.repeat(400) }).userAgent).toHaveLength(255);
  });
});

describe('counting failures and blocking', () => {
  test('below the threshold nothing is blocked', async () => {
    const calls = fakeDb();
    cache.incrementFixedWindow.mockResolvedValue({ count: 19 });
    expect(await ls.noteFailure(PUBLIC_IP)).toBeNull();
    expect(cache.incrementFixedWindow).toHaveBeenCalledWith(`login_fail_ip:${PUBLIC_IP}`, 60 * 60 * 1000);
    expect(calls.some((c) => /INSERT INTO login_ip_blocks/.test(c.sql))).toBe(false);
  });

  test('at the threshold the IP is blocked for the configured hours and the block is audited', async () => {
    const calls = fakeDb();
    cache.incrementFixedWindow.mockResolvedValue({ count: 20 });
    const block = await ls.noteFailure(PUBLIC_IP);
    expect(block).toMatchObject({ id: 41 });
    const insert = calls.find((c) => /INSERT INTO login_ip_blocks/.test(c.sql));
    expect(insert.sql).toMatch(/UTC_TIMESTAMP\(\) \+ INTERVAL \? HOUR/);
    expect(insert.params).toEqual([PUBLIC_IP, 'auto', 20, 24, '20 failed sign-ins in 60 min', null]);
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'login_ip_auto_blocked', organizationId: null, entityType: 'login_ip_blocks', entityId: 41, ipAddress: PUBLIC_IP,
    }));
  });

  test.each([[1, 168], [2, 720], [5, 720]])('an IP blocked %s time(s) in 30 days comes back for %s hours', async (previousBlocks, hours) => {
    const calls = fakeDb({ previousBlocks });
    cache.incrementFixedWindow.mockResolvedValue({ count: 25 });
    await ls.noteFailure(PUBLIC_IP);
    expect(calls.find((c) => /INSERT INTO login_ip_blocks/.test(c.sql)).params[3]).toBe(hours);
  });

  test('an IP already blocked gets no second block', async () => {
    const calls = fakeDb({ active: { id: 9, ip_address: PUBLIC_IP } });
    cache.incrementFixedWindow.mockResolvedValue({ count: 40 });
    expect(await ls.noteFailure(PUBLIC_IP)).toBeNull();
    expect(calls.some((c) => /INSERT INTO login_ip_blocks/.test(c.sql))).toBe(false);
  });

  test('private addresses and a disabled feature are not even counted', async () => {
    fakeDb();
    await ls.noteFailure('192.168.0.5');
    config.loginIpBlock.enabled = false;
    await ls.noteFailure(PUBLIC_IP);
    expect(cache.incrementFixedWindow).not.toHaveBeenCalled();
  });

  test('a failing counter never breaks the sign-in', async () => {
    cache.incrementFixedWindow.mockRejectedValue(new Error('redis down'));
    await expect(ls.noteFailure(PUBLIC_IP)).resolves.toBeNull();
  });

  test('record() writes the IP and browser to their columns and never throws', async () => {
    await ls.record({ action: 'login_failed', email: ' Someone@Example.com ', ctx: { ip: PUBLIC_IP, userAgent: 'UA' }, extra: { reason: 'wrong_password' } });
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'login_failed',
      ipAddress: PUBLIC_IP,
      userAgent: 'UA',
      newValues: { ip: PUBLIC_IP, user_agent: 'UA', email: 'someone@example.com', reason: 'wrong_password' },
    }));
    auditLog.log.mockRejectedValueOnce(new Error('db'));
    await expect(ls.record({ action: 'login_failed' })).resolves.toBeUndefined();
  });
});

describe('the sign-in guard', () => {
  function run(req) {
    const res = { headers: {}, statusCode: 200, body: null };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    const next = jest.fn();
    return loginIpGuard(req, res, next).then(() => ({ res, next }));
  }

  test('a blocked IP gets 429 LOGIN_IP_BLOCKED with Retry-After, and the refusal is counted', async () => {
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    const calls = fakeDb({ active: { id: 9, ip_address: PUBLIC_IP, blocked_until: until } });
    const { res, next } = await run({ ip: PUBLIC_IP });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('LOGIN_IP_BLOCKED');
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(3500);
    expect(calls.some((c) => /refused_count = refused_count \+ 1/.test(c.sql))).toBe(true);
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  test('an IP that is not blocked goes through', async () => {
    fakeDb();
    const { next } = await run({ ip: PUBLIC_IP });
    expect(next).toHaveBeenCalled();
  });

  test('a private IP is not looked up at all', async () => {
    fakeDb();
    const { next } = await run({ ip: '172.19.0.1' });
    expect(next).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a database error lets the sign-in through (lockout and rate limit still apply)', async () => {
    db.query.mockRejectedValue(new Error('down'));
    const { next } = await run({ ip: PUBLIC_IP });
    expect(next).toHaveBeenCalled();
  });

  test('every sign-in route mounts the guard before the password work', () => {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    expect(src('routes/auth.js')).toMatch(/router\.post\('\/login',\s*loginIpGuard,/);
    expect(src('routes/auth.js')).toMatch(/router\.post\('\/login\/2fa',\s*loginIpGuard,/);
    expect(src('routes/portal.js')).toMatch(/router\.post\('\/auth\/login', authLimiter, loginIpGuard,/);
  });
});

describe('the audit action catalog', () => {
  test('sign-in, security and feature actions land in their category', () => {
    expect(categoryOf('login_failed')).toBe('sign_in');
    expect(categoryOf('portal_account_locked')).toBe('sign_in');
    expect(categoryOf('login_ip_auto_blocked')).toBe('security');
    expect(categoryOf('cash_bag_seal')).toBe('cash_bags');
    expect(categoryOf('reseller_statement_settle')).toBe('resellers');
    expect(categoryOf('cfdi_stamped')).toBe('billing');
    expect(categoryOf('transition:done')).toBe('service');
    expect(categoryOf('partial_update')).toBe('records');
    expect(categoryOf('something_new')).toBe('other');
    expect(CATEGORIES).toContain('other');
  });

  // Every literal action a file that writes the audit log uses has a real
  // category, so a new verb does not land in "Other" unnoticed.
  test('every audit action written in src/ is catalogued', () => {
    const root = path.join(__dirname, '..', 'src');
    const actions = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.js')) {
          const s = fs.readFileSync(p, 'utf8');
          if (!/auditLog|audit_logs/.test(s)) continue;
          for (const m of s.matchAll(/action:\s*(['`])([a-z0-9_:]+)\1/g)) actions.add(m[2]);
        }
      }
    };
    walk(root);
    const uncatalogued = [...actions].filter((a) => categoryOf(a) === 'other' && !['other', 'test'].includes(a));
    expect(uncatalogued).toEqual([]);
  });
});

describe('migration 013', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '013_login_audit_ip_blocks.sql'), 'utf8');
  const rollback = fs.readFileSync(path.join(__dirname, '..', 'database', 'rollbacks', '013_login_audit_ip_blocks.sql'), 'utf8');

  test('creates the block list, the permissions for admin only, and the audit action index', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS login_ip_blocks/);
    expect(sql).toMatch(/'login_ip_blocks\.view'.*'security'/);
    expect(sql).toMatch(/'login_ip_blocks\.manage'.*'security'/);
    expect(sql).toMatch(/WHERE r\.name = 'admin'/);
    expect(sql).not.toMatch(/r\.name = 'manager'/);
    expect(sql).toMatch(/ADD KEY idx_audit_logs_org_action \(organization_id, action, created_at\)/);
  });

  test('the rollback undoes all three', () => {
    expect(rollback).toMatch(/DELETE FROM permissions WHERE name IN \('login_ip_blocks\.view', 'login_ip_blocks\.manage'\)/);
    expect(rollback).toMatch(/DROP TABLE IF EXISTS login_ip_blocks/);
    expect(rollback).toMatch(/DROP INDEX idx_audit_logs_org_action/);
  });
});
