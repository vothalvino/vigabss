// =============================================================================
// REG-10 — sessions whose Stop is lost are closed at their last accounting
// =============================================================================
// Accounting-On/Off was only a receipt and nothing swept silent sessions, so a
// session whose Stop never arrived stayed open forever. An open session is
// attributable only while it looks live, so its whole history became
// unattributable. Both closures end the session at its last real accounting.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const {
  recordInfrastructureAccounting,
  closeStaleSessions,
} = require('../src/services/radiusAccountingService');

const closeCalls = () => db.query.mock.calls
  .filter(([sql]) => /UPDATE connection_logs/.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RADIUS_SESSION_LIVENESS_MINUTES;
});

describe('Accounting-On/Off closes the NAS sessions', () => {
  test.each(['Accounting-On', 'Accounting-Off'])('%s closes every session open on that NAS', async (status) => {
    db.query.mockImplementation(async (sql) => (
      /UPDATE connection_logs/.test(sql) ? [{ affectedRows: 3 }] : [{ affectedRows: 1 }]
    ));

    const result = await recordInfrastructureAccounting({
      organizationId: 10, nasId: 4, acctStatusType: status,
    });

    expect(result).toMatchObject({ action: 'closed', closed: 3 });
    const [[sql, params]] = closeCalls();
    expect(sql).toMatch(/SET event_type = 'stop', terminate_cause = \?/);
    // Closed at its last real accounting, not at the restart.
    expect(sql).toMatch(/last_accounting_at = COALESCE\(last_accounting_at, event_at\)/);
    expect(sql).toMatch(/organization_id = \? AND event_type IN \('start', 'interim-update'\) AND nas_id = \?/);
    // A Start received after the signal stays open.
    expect(sql).toMatch(/<= NOW\(3\)/);
    expect(sql).not.toMatch(/LIMIT/);
    expect(params).toEqual(['NAS-Reboot', 'nas_reboot', 10, 4]);
    // The receipt is still recorded.
    expect(db.query.mock.calls.some(([q]) => /collector_ingest_receipts/.test(q))).toBe(true);
  });

  test('a NAS with no open sessions is still a no-op', async () => {
    db.query.mockResolvedValue([{ affectedRows: 0 }]);

    const result = await recordInfrastructureAccounting({
      organizationId: 10, nasId: 4, acctStatusType: 'Accounting-On',
    });

    expect(result).toMatchObject({ action: 'noop', closed: 0 });
  });
});

describe('close_stale_sessions', () => {
  test('closes sessions silent beyond the liveness window, in batches', async () => {
    process.env.RADIUS_SESSION_LIVENESS_MINUTES = '45';
    db.query
      .mockResolvedValueOnce([{ affectedRows: 500 }])
      .mockResolvedValueOnce([{ affectedRows: 12 }]);

    const result = await closeStaleSessions(10);

    expect(result).toEqual({ closed: 512 });
    expect(closeCalls()).toHaveLength(2);
    const [sql, params] = closeCalls()[0];
    expect(sql).toMatch(/COALESCE\(last_accounting_received_at, last_accounting_at, event_at\) < NOW\(3\) - INTERVAL 45 MINUTE/);
    expect(sql).toMatch(/LIMIT 500/);
    expect(sql).not.toMatch(/nas_id = \?/);
    expect(params).toEqual(['Stale-Session', 'stale_session', 10]);
  });

  test('the task is seeded by a migration and dispatched per organization', () => {
    const migrations = path.join(__dirname, '..', 'database', 'migrations');
    const seeded = fs.readdirSync(migrations)
      .some(file => fs.readFileSync(path.join(migrations, file), 'utf8')
        .includes("'close_stale_sessions'"));
    expect(seeded).toBe(true);
    const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'taskRunner.js'), 'utf8');
    expect(runner).toMatch(/case 'close_stale_sessions':[\s\S]{0,200}perOrganization\(taskName, organizationId,\s*orgId => radiusAccountingService\.closeStaleSessions\(orgId\)\)/);
  });
});
