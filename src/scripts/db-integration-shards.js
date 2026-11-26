'use strict';
// =============================================================================
// Run the real-database suites with the isolation sweep split into parts
// =============================================================================
// The sweep's write half sends one request at a time and checks every row of
// the other organization after each, which is most of the db-integration
// job's time and uses one core. This runs it as several processes side by
// side, each sweeping its share of the write routes (DB_SWEEP_SHARD) against
// its own database, so a change is still attributed to the one request that
// made it.
//
//   node src/scripts/db-integration-shards.js <jest path>
//
// The path is what the job would have handed to jest: the sweep file alone, or
// the folder (the other suites then run afterwards, on the first database).
// DB_SWEEP_SHARDS sets the number of parts (4 by default; 1 runs it as before).
// The first part uses DB_NAME, which must exist; the others use DB_NAME_s2,
// _s3, ... which are created here. All of them are migrated here, in parallel.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.resolve(__dirname, '..', '..');
const SWEEP = 'tests/integration/db/tenantIsolationSweep.test.js';
const JEST = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

function run(label, args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('close', (code) => resolve({ label, code, seconds: Math.round((Date.now() - started) / 1000), output: Buffer.concat(out).toString() }));
  });
}

function print(result) {
  // One block per process: side-by-side output would interleave.
  console.log(`::group::${result.label} — ${result.code === 0 ? 'passed' : `FAILED (exit ${result.code})`} in ${result.seconds}s`);
  console.log(result.output.trimEnd());
  console.log('::endgroup::');
}

/** part → { database, report } */
function plan(parts, baseDb, baseReport) {
  return Array.from({ length: parts }, (_, i) => {
    const part = i + 1;
    return {
      part,
      database: part === 1 ? baseDb : `${baseDb}_s${part}`,
      report: part === 1 || !baseReport ? baseReport : baseReport.replace(/\.json$/, `.part${part}.json`),
    };
  });
}

/** One writes report for the whole sweep from the parts' reports. */
function mergeWriteReports(reports) {
  const merged = { ...reports[0], shard: `1-${reports.length}/${reports.length}`, routes: 0, requests: 0, byStatus: {} };
  for (const key of ['changed', 'linked', 'accepted', 'unresolved', 'installWide', 'mxOnly', 'initialLinks']) merged[key] = [];
  for (const report of reports) {
    merged.routes += report.routes || 0;
    merged.requests += report.requests || 0;
    for (const [status, n] of Object.entries(report.byStatus || {})) merged.byStatus[status] = (merged.byStatus[status] || 0) + n;
    for (const key of ['changed', 'linked', 'accepted', 'unresolved', 'installWide', 'mxOnly']) merged[key].push(...(report[key] || []));
  }
  merged.initialLinks = reports[0].initialLinks || [];
  return merged;
}

async function createDatabases(names) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  try {
    // These databases are thrown away with the job, so the server need not
    // sync every commit to disk; that is a good part of the migration time.
    // Best effort: a server that refuses changes nothing but the speed.
    for (const sql of ['SET GLOBAL innodb_flush_log_at_trx_commit = 0', 'SET GLOBAL sync_binlog = 0']) {
      try { await conn.query(sql); } catch (err) { console.log(`skipped "${sql}": ${err.message}`); }
    }
    for (const name of names) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
      await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
  } finally {
    await conn.end();
  }
}

async function main() {
  const target = process.argv[2] || 'tests/integration/db';
  const parts = Math.max(1, Math.min(16, Number(process.env.DB_SWEEP_SHARDS) || 4));
  const baseDb = process.env.DB_NAME || 'vigabss_integration';
  const baseReport = process.env.DB_INTEGRATION_REPORT || '';
  const shards = plan(parts, baseDb, baseReport);
  const jestArgs = ['--ci', '--runInBand', '--forceExit'];
  let failed = false;

  // Every database is migrated here, side by side: the first one exists
  // already (the job's MySQL service creates it), the others are made fresh.
  await createDatabases(shards.slice(1).map((s) => s.database));
  const migrated = await Promise.all(shards.map((s) => run(
    `migrate ${s.database}`, [path.join(ROOT, 'src', 'scripts', 'migrate.js')], { DB_NAME: s.database },
  )));
  for (const result of migrated) {
    if (result.code !== 0) { print(result); failed = true; }
    else console.log(`${result.label}: done in ${result.seconds}s`);
  }
  if (failed) process.exit(1);

  const swept = await Promise.all(shards.map((s) => run(
    `isolation sweep, part ${s.part} of ${parts}`,
    [JEST, SWEEP, ...jestArgs],
    { DB_NAME: s.database, DB_SWEEP_SHARD: `${s.part}/${parts}`, ...(s.report ? { DB_INTEGRATION_REPORT: s.report } : {}) },
  )));
  for (const result of swept) { print(result); if (result.code !== 0) failed = true; }

  if (baseReport && parts > 1) {
    const files = shards.map((s) => s.report.replace(/\.json$/, '-writes.json')).filter((f) => fs.existsSync(path.resolve(ROOT, f)));
    if (files.length === parts) {
      const reports = files.map((f) => JSON.parse(fs.readFileSync(path.resolve(ROOT, f), 'utf8')));
      fs.writeFileSync(path.resolve(ROOT, files[0]), JSON.stringify(mergeWriteReports(reports), null, 2));
      for (const s of shards.slice(1)) {
        for (const f of [s.report, s.report.replace(/\.json$/, '-writes.json')]) fs.rmSync(path.resolve(ROOT, f), { force: true });
      }
    }
  }

  // The folder was asked for: the other real-database suites, on the first database.
  if (path.normalize(target) !== path.normalize(SWEEP)) {
    const others = await run('other real-database suites', [JEST, target, '--testPathIgnorePatterns', 'tenantIsolationSweep', ...jestArgs], { DB_NAME: baseDb });
    print(others);
    if (others.code !== 0) failed = true;
  }

  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { plan, mergeWriteReports };
