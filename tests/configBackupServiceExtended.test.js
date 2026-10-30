jest.mock('../src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }),
}));

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

jest.mock('../src/services/firerelayTunnel', () => ({
  tunnelServer: { sendCommand: jest.fn(), isConnected: jest.fn() },
}));

const db = require('../src/config/database');
const { NotFoundError } = require('../src/utils/errors');
const { MAX_REGEX_SUBJECT_LENGTH } = require('../src/utils/safeRegex');
const { tunnelServer } = require('../src/services/firerelayTunnel');
const {
  computeDiff,
  runComplianceAudit,
  evaluateRule,
  pullBackupWithDiff,
  deployConfigTemplate,
  sha256,
} = require('../src/services/configBackupService');

describe('computeDiff', () => {
  test('returns empty string for identical content', () => {
    expect(computeDiff('line1\nline2', 'line1\nline2')).toBe('');
  });

  test('returns diff lines with +/- for changed content', () => {
    const diff = computeDiff('line1\nline2', 'line1\nline3');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+line3');
  });

  test('returns only additions for new content', () => {
    const diff = computeDiff('', 'newline');
    expect(diff).toContain('+newline');
  });
});

describe('runComplianceAudit', () => {
  afterEach(() => jest.clearAllMocks());

  const backupRow = { id: 1, device_id: 10, content: 'ip route add\nno telnet' };
  const deviceRow = { id: 10, device_type: 'router' };

  function setupMocks(rules) {
    db.query
      .mockResolvedValueOnce([[backupRow]])   // load backup
      .mockResolvedValueOnce([[deviceRow]])   // load device
      .mockResolvedValueOnce([rules]);        // load rules
    // For each rule insert
    rules.forEach(() => db.query.mockResolvedValueOnce([{ insertId: 99 }]));
  }

  test('must_contain: passes when pattern present', async () => {
    const rules = [{ id: 1, rule_type: 'must_contain', pattern: 'ip route', applies_to_device_type: null }];
    setupMocks(rules);
    const result = await runComplianceAudit(1, 5);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('must_not_contain: fails when pattern present', async () => {
    const rules = [{ id: 1, rule_type: 'must_not_contain', pattern: 'no telnet', applies_to_device_type: null }];
    setupMocks(rules);
    const result = await runComplianceAudit(1, 5);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
  });

  test('regex_match: passes when regex matches', async () => {
    const rules = [{ id: 1, rule_type: 'regex_match', pattern: 'ip\\s+route', applies_to_device_type: null }];
    setupMocks(rules);
    const result = await runComplianceAudit(1, 5);
    expect(result.passed).toBe(1);
  });

  test('inserts result rows into db', async () => {
    const rules = [{ id: 1, rule_type: 'must_contain', pattern: 'ip route', applies_to_device_type: null }];
    setupMocks(rules);
    await runComplianceAudit(1, 5);
    // 4 queries: backup, device, rules, INSERT
    expect(db.query).toHaveBeenCalledTimes(4);
    const insertCall = db.query.mock.calls[3];
    expect(insertCall[0]).toContain('INSERT INTO config_compliance_results');
  });

  test('throws when backup not found', async () => {
    db.query.mockResolvedValueOnce([[]]); // empty backup
    await expect(runComplianceAudit(999, 5)).rejects.toThrow('not found');
  });

  test('binds the backup lookup to the caller org and 404s a foreign backup before writing', async () => {
    db.query.mockResolvedValueOnce([[]]); // org-bound backup lookup misses
    const err = await runComplianceAudit(2005, 5).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.statusCode).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/FROM device_config_backups WHERE id = \?[\s\S]*organization_id <=> \?/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(params).toEqual([2005, 5]);
    expect(db.query.mock.calls.some(([q]) => /INSERT INTO config_compliance_results/.test(q))).toBe(false);
  });

  test('scopes the device-type lookup to the caller org', async () => {
    setupMocks([]);
    await runComplianceAudit(1, 5);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/FROM devices WHERE id = \? AND organization_id <=> \?/);
    expect(params).toEqual([10, 5]);
  });

  test('a catastrophic regex rule is recorded as error without being executed', async () => {
    const rules = [{ id: 7, rule_type: 'regex_not_match', pattern: '(a+)+$', applies_to_device_type: null }];
    setupMocks(rules);
    const started = Date.now();
    const result = await runComplianceAudit(1, 5);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toEqual({ total: 1, passed: 0, failed: 1 });
    const insert = db.query.mock.calls[3];
    expect(insert[1][3]).toBe('error');
    expect(insert[1][4]).toMatch(/nested unbounded quantifiers/);
  });
});

describe('evaluateRule', () => {
  test('regex over a subject larger than the cap is an error, not evaluated', () => {
    const big = 'a'.repeat(MAX_REGEX_SUBJECT_LENGTH + 1);
    const out = evaluateRule({ rule_type: 'regex_match', pattern: 'a' }, big);
    expect(out.result).toBe('error');
    expect(out.details).toMatch(/exceeds/);
  });

  test('literal rules are not subject to the regex cap', () => {
    const big = 'a'.repeat(MAX_REGEX_SUBJECT_LENGTH + 1);
    expect(evaluateRule({ rule_type: 'must_contain', pattern: 'aaa' }, big).result).toBe('pass');
  });

  test('invalid regex syntax is an error', () => {
    expect(evaluateRule({ rule_type: 'regex_match', pattern: '(' }, 'x').result).toBe('error');
  });

  test('regex_not_match fails on a violation', () => {
    expect(evaluateRule({ rule_type: 'regex_not_match', pattern: 'telnet\\s+disabled=no' }, 'telnet disabled=no').result)
      .toBe('fail');
  });
});

describe('pullBackupWithDiff', () => {
  afterEach(() => jest.clearAllMocks());

  test('returns skipped result unchanged', async () => {
    const content = 'same config';
    const checksum = sha256(content);
    // pullBackupForDevice will be called internally — mock db
    tunnelServer.sendCommand.mockResolvedValueOnce({ content, configType: 'mikrotik_export' });
    db.query
      .mockResolvedValueOnce([[{ content: 'old' }]])      // prevContent lookup
      .mockResolvedValueOnce([[{ checksum }]])             // getLatestChecksum — same → skip
    ;
    const result = await pullBackupWithDiff({
      deviceId: 1, nodeId: 'n1', host: '1.2.3.4', user: 'admin', password: 'x',
    });
    expect(result.skipped).toBe(true);
  });

  test('updates backup with diff when new backup is stored', async () => {
    const prevContent = 'line1\nline2';
    const newContent = 'line1\nline3';
    const oldChecksum = sha256(prevContent);
    const newChecksum = sha256(newContent);

    tunnelServer.sendCommand.mockResolvedValueOnce({ content: newContent, configType: 'mikrotik_export' });
    db.query
      .mockResolvedValueOnce([[{ content: prevContent }]])  // prevContent
      .mockResolvedValueOnce([[{ checksum: oldChecksum }]]) // getLatestChecksum (different → new backup)
      .mockResolvedValueOnce([[{ version: 1 }]])            // getLatestVersion
      .mockResolvedValueOnce([{ insertId: 5 }])             // INSERT
      .mockResolvedValueOnce([[{ content: newContent }]])   // new content for diff
      .mockResolvedValueOnce([{ affectedRows: 1 }])         // UPDATE diff
    ;
    const result = await pullBackupWithDiff({
      deviceId: 1, nodeId: 'n1', host: '1.2.3.4', user: 'admin', password: 'x',
    });
    expect(result.skipped).toBe(false);
    expect(result.backupId).toBe(5);
    expect(result.checksum).toBe(newChecksum);
    // Verify UPDATE was called
    const updateCall = db.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('UPDATE device_config_backups SET diff_from_previous'));
    expect(updateCall).toBeDefined();
  });
});

describe('deployConfigTemplate', () => {
  afterEach(() => jest.clearAllMocks());

  // Contract change (NET-09): there is no device push mechanism, so a deploy
  // renders the template and records 'pending' (never 'success'), returning the
  // rendered config for manual application. Lookups now take the caller's org.
  test('renders template with variables and records a pending, not-pushed deployment', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 5, template_content: 'hostname {{hostname}}', status: 'active' }]])
      .mockResolvedValueOnce([[{ id: 10 }]])
      .mockResolvedValueOnce([{ insertId: 20 }]);
    const record = await deployConfigTemplate(1, 10, { hostname: 'Router1' }, 99, 5);
    expect(record.id).toBe(20);
    expect(record.status).toBe('pending');
    expect(record.push_performed).toBe(false);
    expect(record.rendered_config).toBe('hostname Router1');
    expect(db.query.mock.calls[2][0]).toContain('INSERT INTO config_deployment_records');
    expect(db.query.mock.calls[2][1]).toContain('pending');
    expect(db.query.mock.calls[2][1]).not.toContain('success');
    expect(tunnelServer.sendCommand).not.toHaveBeenCalled();
  });

  test('throws NotFoundError when template not found', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(deployConfigTemplate(999, 1, {}, 1, 5)).rejects.toThrow(NotFoundError);
  });

  test('throws NotFoundError when device not found', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 1, organization_id: 5, template_content: 'x', status: 'active' }]])
      .mockResolvedValueOnce([[]]); // device not found
    await expect(deployConfigTemplate(1, 999, {}, 1, 5)).rejects.toThrow(NotFoundError);
  });

  test('refuses an unscoped call with no orgId', async () => {
    await expect(deployConfigTemplate(1, 10, {}, 1)).rejects.toThrow(/requires an orgId/);
    expect(db.query).not.toHaveBeenCalled();
  });
});
