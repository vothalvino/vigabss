// =============================================================================
// VigaBSS 5.0 — DR Drill Service Tests
// =============================================================================

jest.mock('../src/config/database');
jest.mock('../src/scripts/backup');
// The restore test opens its own connections and runs the mysql client. By
// default the scratch database is refused (an install that has not been
// granted it yet); the restore-test block below turns it on.
const mockScratch = { denied: true, liveTables: 12, restoredTables: 12, clientExit: 0, queries: [] };
jest.mock('mysql2/promise', () => ({
  ...jest.requireActual('mysql2/promise'),
  createConnection: jest.fn(async () => ({
    query: jest.fn(async (sql, params) => {
      mockScratch.queries.push(sql);
      const q = sql.toLowerCase();
      if (q.startsWith('drop database') || q.startsWith('create database')) {
        if (mockScratch.denied) throw Object.assign(new Error('Access denied'), { code: 'ER_DBACCESS_DENIED_ERROR' });
        return [{}];
      }
      if (q.includes('information_schema.tables')) {
        return [[{ n: params[0].endsWith('_drill') ? mockScratch.restoredTables : mockScratch.liveTables }]];
      }
      if (q.includes('count(*) as cnt')) return [[{ cnt: 5 }]];
      return [[{ n: 0 }]];
    }),
    end: jest.fn(async () => {}),
  })),
}));
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(() => {
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new EventEmitter();
    child.stdin.resume();
    child.stdin.on('finish', () => {
      if (mockScratch.clientExit !== 0) child.stderr.emit('data', Buffer.from('ERROR 1064 (42000) at line 3: bad statement'));
      child.emit('close', mockScratch.clientExit);
    });
    return child;
  }),
}));

const db = require('../src/config/database');
const { backup } = require('../src/scripts/backup');
const drDrillService = require('../src/services/drDrillService');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up db.query to return the standard "healthy" responses. */
function setupHealthyDb() {
  db.query.mockImplementation(async (sql) => {
    const q = sql.toLowerCase();

    // Row-count queries — COUNT(*) AS cnt
    if (q.includes('count(*) as cnt')) return [[{ cnt: 5 }]];

    // FK orphan queries — COUNT(*) AS n, result must be 0
    if (q.includes('count(*) as n')) return [[{ n: 0 }]];

    // INSERT into dr_drill_logs
    if (q.includes('insert into dr_drill_logs')) return [{ insertId: 1 }];

    // SELECT * FROM dr_drill_logs
    if (q.includes('select * from dr_drill_logs')) return [[]];

    return [[]];
  });
}

/**
 * Write a structurally valid fake dump: real gzip, contains CREATE TABLE,
 * ends with the mysqldump completion trailer, and (via incompressible random
 * base64 payload) comfortably exceeds the 64 KB size floor.
 */
function healthyDumpGz({ trailer = true, sizeBoost = true } = {}) {
  const crypto = require('crypto');
  const parts = [
    '-- MySQL dump 10.19\n',
    'CREATE TABLE `clients` (`id` int NOT NULL);\n',
  ];
  if (sizeBoost) {
    for (let i = 0; i < 40; i++) {
      parts.push(`INSERT INTO blobs VALUES ('${crypto.randomBytes(3000).toString('base64')}');\n`);
    }
  }
  if (trailer) parts.push('-- Dump completed on 2026-07-17 20:00:00\n');
  return zlib.gzipSync(Buffer.from(parts.join('')));
}

/** Set up backup mock to return a healthy backup filepath. */
function setupHealthyBackup(tmpPath) {
  fs.writeFileSync(tmpPath, healthyDumpGz());
  backup.mockResolvedValue({ filepath: tmpPath, cloudUrl: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('drDrillService.runDrill', () => {
  const tmpFile = path.join(require('os').tmpdir(), 'dr_drill_test.sql.gz');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('returns status=pass when backup is large enough and all checks pass', async () => {
    setupHealthyBackup(tmpFile);
    setupHealthyDb();

    const result = await drDrillService.runDrill();

    expect(result.status).toBe('pass');
    expect(result.checks.backup_size_ok).toBe(true);
    expect(result.checks.fk_orphans_ok).toBe(true);
    expect(result.checks.financial_ok).toBe(true);
    expect(result.checks.schema_migrations_present).toBe(true);
    expect(typeof result.duration_ms).toBe('number');
  });

  it('throws and writes error log when backup file is too small', async () => {
    // Under the 64 KB floor
    fs.writeFileSync(tmpFile, Buffer.alloc(512, 'x'));
    backup.mockResolvedValue({ filepath: tmpFile, cloudUrl: null });
    setupHealthyDb();

    await expect(drDrillService.runDrill()).rejects.toThrow(/Backup too small/);

    const insertCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.toLowerCase().includes('insert into dr_drill_logs'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[1][0]).toBe('error');
  });

  it('a COMPLETE small-org dump passes — the old 1 MB floor was a false positive', async () => {
    // ~300 KB gz like a populated install: structurally complete, over the 64 KB
    // floor, but far under the old hardcoded 1 MB minimum.
    setupHealthyBackup(tmpFile);
    expect(fs.statSync(tmpFile).size).toBeLessThan(1_048_576);
    setupHealthyDb();

    const result = await drDrillService.runDrill();
    expect(result.status).toBe('pass');
    expect(result.checks.backup_size_ok).toBe(true);
    expect(result.checks.backup_structure_ok).toBe(true);
  });

  it('rejects a truncated dump (no "-- Dump completed" trailer) regardless of size', async () => {
    fs.writeFileSync(tmpFile, healthyDumpGz({ trailer: false }));
    backup.mockResolvedValue({ filepath: tmpFile, cloudUrl: null });
    setupHealthyDb();

    await expect(drDrillService.runDrill()).rejects.toThrow(/truncated dump/);
  });

  it('phase-4 SQL names real columns and guards NULLable FKs (regression: subtotal/amount_applied crashes)', async () => {
    // These queries first became reachable in production once Phase 1 stopped
    // failing — and promptly crashed on columns that don't exist
    // (invoice_items.subtotal, payment_allocations.amount_applied) and
    // counted NULLable FKs (radius.contract_id, users.organization_id) as
    // orphans.
    setupHealthyBackup(tmpFile);
    setupHealthyDb();
    await drDrillService.runDrill();

    const sqls = db.query.mock.calls.map(([sql]) => sql).filter((s) => typeof s === 'string');
    const items = sqls.find((s) => s.includes('invoice_items'));
    const allocs = sqls.find((s) => s.includes('payment_allocations') && s.includes('SUM('));
    // SUM(amount): the value every writer folds into invoices.subtotal — the
    // GENERATED q×p `total` column drifts by sub-cent rounding on
    // fractional-quantity (overage) lines and would flag healthy invoices.
    expect(items).toContain('SUM(amount)');
    expect(items).not.toContain('SUM(subtotal)');
    expect(items).not.toContain('SUM(total)');
    expect(allocs).toContain('SUM(amount)');
    expect(allocs).not.toContain('amount_applied');
    expect(sqls.some((s) => s.includes('r.contract_id IS NOT NULL'))).toBe(true);
    expect(sqls.some((s) => s.includes('u.organization_id IS NOT NULL'))).toBe(true);
  });

  it('rejects a large file that is not a valid gzip stream', async () => {
    fs.writeFileSync(tmpFile, Buffer.alloc(200_000, 'x'));
    backup.mockResolvedValue({ filepath: tmpFile, cloudUrl: null });
    setupHealthyDb();

    await expect(drDrillService.runDrill()).rejects.toThrow(/not a valid gzip/);
  });

  it('returns status=fail when FK orphans are detected', async () => {
    setupHealthyBackup(tmpFile);

    db.query.mockImplementation(async (sql) => {
      const q = sql.toLowerCase();

      if (q.includes('count(*) as cnt')) return [[{ cnt: 5 }]];

      // Simulate orphaned contracts (FK orphan queries contain "contracts" and "clients")
      if (q.includes('count(*) as n') && q.includes('contracts') && q.includes('clients')) {
        return [[{ n: 3 }]];
      }
      if (q.includes('count(*) as n')) return [[{ n: 0 }]];

      if (q.includes('insert into dr_drill_logs')) return [{ insertId: 1 }];
      return [[]];
    });

    const result = await drDrillService.runDrill();

    expect(result.status).toBe('fail');
    expect(result.checks.fk_orphans_ok).toBe(false);
    expect(result.checks.fk_orphans.orphaned_contracts).toBe(3);
  });

  it('returns status=fail when financial inconsistencies are detected', async () => {
    setupHealthyBackup(tmpFile);

    db.query.mockImplementation(async (sql) => {
      const q = sql.toLowerCase();

      if (q.includes('count(*) as cnt')) return [[{ cnt: 5 }]];
      // FK orphan queries all zero (these contain COUNT(*) AS n but not invoice_items/payment_allocations)
      if (q.includes('count(*) as n') && !q.includes('invoice_items') && !q.includes('payment_allocations')) {
        return [[{ n: 0 }]];
      }
      // Financial check — inconsistent invoices
      if (q.includes('invoice_items')) return [[{ n: 2 }]];
      if (q.includes('payment_allocations')) return [[{ n: 0 }]];
      if (q.includes('count(*) as n')) return [[{ n: 0 }]];

      if (q.includes('insert into dr_drill_logs')) return [{ insertId: 1 }];
      return [[]];
    });

    const result = await drDrillService.runDrill();

    expect(result.status).toBe('fail');
    expect(result.checks.financial_ok).toBe(false);
    expect(result.checks.financial.inconsistent_invoices).toBe(2);
  });

  it('throws and writes error log when backup() rejects', async () => {
    backup.mockRejectedValue(new Error('mysqldump not found'));
    setupHealthyDb();

    await expect(drDrillService.runDrill()).rejects.toThrow('mysqldump not found');

    const insertCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.toLowerCase().includes('insert into dr_drill_logs'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[1][0]).toBe('error');
  });
});

describe('drDrillService.getDrillStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns overdue=true and null fields when no logs exist', async () => {
    db.query.mockResolvedValue([[]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.overdue).toBe(true);
    expect(status.last_run_at).toBeNull();
    expect(status.status).toBeNull();
  });

  it('returns overdue=false for a recent passing drill', async () => {
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    db.query.mockResolvedValue([[
      { run_at: recentDate, status: 'pass', error_message: null },
    ]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.overdue).toBe(false);
    expect(status.status).toBe('pass');
    expect(status.days_since_drill).toBe(10);
  });

  it('returns overdue=true when last drill was more than 90 days ago', async () => {
    const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000); // 95 days ago
    db.query.mockResolvedValue([[
      { run_at: oldDate, status: 'pass', error_message: null },
    ]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.overdue).toBe(true);
    expect(status.days_since_drill).toBeGreaterThanOrEqual(95);
  });

  it('returns overdue=true when last drill failed regardless of date', async () => {
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    db.query.mockResolvedValue([[
      { run_at: recentDate, status: 'fail', error_message: 'FK orphans detected' },
    ]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.overdue).toBe(true);
    expect(status.last_error).toBe('FK orphans detected');
  });

  it('returns overdue=true when last drill had status=error', async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    db.query.mockResolvedValue([[
      { run_at: recentDate, status: 'error', error_message: 'mysqldump not found' },
    ]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.overdue).toBe(true);
  });
});

describe('drDrillService restore test', () => {
  let tmpFile;
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockScratch, { denied: false, liveTables: 12, restoredTables: 12, clientExit: 0, queries: [] });
    setupHealthyDb();
    tmpFile = path.join(require('os').tmpdir(), `drill_restore_${Date.now()}_${Math.round(process.hrtime()[1])}.sql.gz`);
    fs.writeFileSync(tmpFile, healthyDumpGz());
    backup.mockResolvedValue({ filepath: tmpFile, cloudUrl: null });
  });
  afterEach(() => {
    mockScratch.denied = true;
    try { fs.unlinkSync(tmpFile); } catch { /* gone */ }
  });

  it('restores the backup into the scratch database, checks it and drops it', async () => {
    const out = await drDrillService.runDrill();
    expect(out.status).toBe('pass');
    expect(out.checks.restore).toMatchObject({ performed: true, ok: true, tables_live: 12, tables_restored: 12 });
    const spawn = require('child_process').spawn;
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawn.mock.calls[0];
    expect(command).toBe('mysql');
    expect(args[args.length - 1]).toBe(drDrillService.scratchName());
    // The password travels in the environment, never in the arguments.
    expect(args.join(' ')).not.toMatch(/password/i);
    expect(opts.shell).toBeUndefined();
    const drops = mockScratch.queries.filter((q) => q.startsWith('DROP DATABASE'));
    expect(drops).toHaveLength(2);
    // Only ever the scratch database.
    for (const q of mockScratch.queries.filter((x) => /^(DROP|CREATE) DATABASE/.test(x))) {
      expect(q).toContain(`\`${drDrillService.scratchName()}\``);
    }
  });

  it('fails the drill when the restored copy has fewer tables than the live database', async () => {
    mockScratch.restoredTables = 9;
    const out = await drDrillService.runDrill();
    expect(out.status).toBe('fail');
    expect(out.checks.restore.ok).toBe(false);
    const insert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO dr_drill_logs'));
    expect(insert[1][4]).toMatch(/9 tables.*12/);
  });

  it('a backup the mysql client refuses is an error, and the scratch database is still dropped', async () => {
    mockScratch.clientExit = 1;
    await expect(drDrillService.runDrill()).rejects.toThrow(/Restoring the backup failed.*ERROR 1064/);
    expect(mockScratch.queries.filter((q) => q.startsWith('DROP DATABASE'))).toHaveLength(2);
  });

  it('without rights on the scratch database the restore test is skipped and the drill still passes', async () => {
    mockScratch.denied = true;
    const out = await drDrillService.runDrill();
    expect(out.status).toBe('pass');
    expect(out.checks.restore).toEqual({ performed: false, reason: 'no_scratch_rights', database: drDrillService.scratchName() });
    expect(require('child_process').spawn).not.toHaveBeenCalled();
  });

  it('the status reports the restore test and whether a drill is running', async () => {
    db.query.mockResolvedValue([[{
      run_at: new Date(), status: 'pass', error_message: null, duration_ms: 4200, backup_size_bytes: 2097152,
      checks: JSON.stringify({ restore: { performed: true, ok: true, restore_ms: 3100, tables_live: 12, tables_restored: 12 } }),
    }]]);
    const status = await drDrillService.getDrillStatus();
    expect(status.restore).toEqual({ performed: true, ok: true, reason: null, restore_ms: 3100, tables_live: 12, tables_restored: 12 });
    expect(status).toMatchObject({ running: false, duration_ms: 4200, backup_size_bytes: 2097152 });
  });

  it('starts one drill at a time', async () => {
    setupHealthyDb();
    const first = drDrillService.startDrill();
    const second = drDrillService.startDrill();
    expect(first.started).toBe(true);
    expect(second).toEqual({ started: false, running_since: first.running_since });
    expect((await drDrillService.getDrillStatus()).running).toBe(true);
    for (let i = 0; i < 200 && (await drDrillService.getDrillStatus()).running; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await drDrillService.getDrillStatus()).running).toBe(false);
    expect(drDrillService.startDrill().started).toBe(true);
    for (let i = 0; i < 200 && (await drDrillService.getDrillStatus()).running; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });
});
