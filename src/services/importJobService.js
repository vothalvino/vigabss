// =============================================================================
// VigaBSS 5.0 — CSV imports as background jobs
// =============================================================================
// An import parsed and inserted up to 10,000 rows inside the web request: a
// large file held the request (and a connection) for minutes, the proxy timed
// it out while rows were still being inserted, and the caller could not tell
// what had been imported. The request now stores the CSV in import_jobs
// (migration 522), queues a csv-import job and answers 202. The worker runs
// the same import handler on the stored CSV and records its result.
//
// An import is not idempotent: rows inserted before a crash stay. A job found
// 'running' when it is picked up again (the process stopped mid-import) is
// therefore failed with a note to check, never run a second time.
// =============================================================================

const db = require('../config/database');
const { AppError, NotFoundError } = require('../utils/errors');
const logger = require('../utils/logger').child({ service: 'importJobs' });

const ENTITIES = Object.freeze(['clients', 'devices', 'contracts', 'invoices', 'payments']);

// The permission a caller needs to import, or to read the job of, each entity.
const ENTITY_PERMISSION = Object.freeze({
  clients: 'clients.create',
  devices: 'devices.create',
  contracts: 'contracts.create',
  invoices: 'invoices.create',
  payments: 'payments.create',
});

// The handler that imports each entity from { body: { csv } }.
const HANDLER = Object.freeze({
  clients: 'importClients',
  devices: 'importDevices',
  contracts: 'importContracts',
  invoices: 'importInvoices',
  payments: 'importPayments',
});

const MAX_ERRORS_KEPT = 1000;

// What the API shows of a job: never the CSV.
const PUBLIC_COLUMNS = `id, organization_id, entity, status, total_rows, imported_rows, row_errors,
       error_message, created_by, started_at, completed_at, created_at, updated_at`;

function parseErrors(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return []; }
}

function present(row) {
  return row && { ...row, row_errors: parseErrors(row.row_errors) };
}

async function queueImportJob(jobId, organizationId) {
  const jobQueue = require('./jobQueueService');
  await jobQueue.add('csv-import', { jobId: Number(jobId), organizationId: Number(organizationId) }, {
    jobId: `csv-import-${jobId}`,
    attempts: 1,
  }).catch((err) => {
    // The row is durable; resumeImportJobs queues it at the next start.
    logger.warn({ err: err.message, jobId }, 'Could not queue the import job; it resumes at the next start');
  });
}

/**
 * Store the CSV and queue its import.
 * @returns {Promise<object>} the queued job
 */
async function createImportJob({ organizationId, entity, csv, userId = null }) {
  if (!ENTITIES.includes(entity)) throw new AppError(`Unknown import '${entity}'`, 404, 'NOT_FOUND');
  // A UTF-8 byte-order mark would become part of the first header.
  const text = String(csv ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new AppError('The CSV is empty', 422, 'VALIDATION_ERROR');
  const [result] = await db.query(
    'INSERT INTO import_jobs (organization_id, entity, csv_payload, created_by) VALUES (?, ?, ?, ?)',
    [organizationId, entity, text, userId],
  );
  await queueImportJob(result.insertId, organizationId);
  return getImportJob(result.insertId, organizationId);
}

async function getImportJob(jobId, organizationId) {
  const [[row]] = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM import_jobs WHERE id = ? AND organization_id = ?`,
    [jobId, organizationId],
  );
  if (!row) throw new NotFoundError('Import job');
  return present(row);
}

/** The organization's recent imports of these entities, newest first. */
async function listImportJobs(organizationId, entities, { limit = 20 } = {}) {
  if (!entities.length) return [];
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const [rows] = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM import_jobs
      WHERE organization_id = ? AND entity IN (${entities.map(() => '?').join(', ')})
      ORDER BY id DESC LIMIT ${limitNum}`,
    [organizationId, ...entities],
  );
  return rows.map(present);
}

// Run an import handler as the request would have, capturing its answer.
async function runHandler(handlerName, { organizationId, userId, csv }) {
  const importController = require('../controllers/importController');
  let status = 200;
  let body;
  let thrown;
  const req = { orgId: organizationId, user: userId ? { id: userId } : null, body: { csv } };
  const res = {
    status(code) { status = code; return res; },
    json(payload) { body = payload; return res; },
  };
  await importController[handlerName](req, res, (err) => { thrown = err; });
  if (thrown) throw thrown;
  return { status, body };
}

async function finish(jobId, organizationId, fields) {
  const keys = Object.keys(fields);
  await db.query(
    `UPDATE import_jobs SET ${keys.map(k => `${k} = ?`).join(', ')}, csv_payload = NULL, completed_at = NOW()
      WHERE id = ? AND organization_id = ?`,
    [...keys.map(k => fields[k]), jobId, organizationId],
  );
}

/**
 * Run one queued import. Holds the job's advisory lock, so a job queued by
 * several replicas (a resume) runs once.
 */
async function processImportJob(jobId, organizationId) {
  const { withAdvisoryLock } = require('../utils/advisoryLock');
  return withAdvisoryLock(`csv-import:${jobId}`, async () => {
    const [[job]] = await db.query(
      'SELECT id, entity, status, csv_payload, created_by FROM import_jobs WHERE id = ? AND organization_id = ?',
      [jobId, organizationId],
    );
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    if (job.status === 'running') {
      // The process stopped mid-import: some rows may be in. Never re-run.
      await finish(job.id, organizationId, {
        status: 'failed',
        error_message: 'Interrupted while importing. Some rows may have been created; check before importing the file again.',
      });
      return;
    }
    await db.query(
      "UPDATE import_jobs SET status = 'running', started_at = NOW() WHERE id = ? AND organization_id = ? AND status = 'queued'",
      [job.id, organizationId],
    );
    try {
      const { status, body } = await runHandler(HANDLER[job.entity], {
        organizationId, userId: job.created_by, csv: job.csv_payload || '',
      });
      if (status >= 400) {
        await finish(job.id, organizationId, { status: 'failed', error_message: String(body?.error?.message || `Import refused (${status})`).slice(0, 500) });
        return;
      }
      const result = body?.data || {};
      const errors = Array.isArray(result.errors) ? result.errors : [];
      await finish(job.id, organizationId, {
        status: 'completed',
        total_rows: Number(result.total) || 0,
        imported_rows: Number(result.imported) || 0,
        row_errors: JSON.stringify(errors.slice(0, MAX_ERRORS_KEPT)),
      });
      logger.info({ jobId: job.id, entity: job.entity, imported: result.imported, total: result.total }, 'Import finished');
    } catch (err) {
      logger.error({ err, jobId: job.id }, 'Import failed');
      await finish(job.id, organizationId, { status: 'failed', error_message: String(err.message || 'Import failed').slice(0, 500) });
    }
  });
}

/**
 * Queue every unfinished import again: the in-process queue (no Redis) loses
 * its jobs on a restart. A 'running' one is failed by processImportJob.
 * @returns {Promise<number>} jobs queued
 */
async function resumeImportJobs() {
  let count = 0;
  const fanOut = require('./organizationFanOut');
  await fanOut.forEachDatabaseScope('resume_import_jobs', async (scopeOrgId) => {
    const { sql, params } = fanOut.orgScopeFilter('organization_id', scopeOrgId);
    const [rows] = await db.query(
      `SELECT id, organization_id FROM import_jobs WHERE status IN ('queued','running')${sql}`,
      params,
    );
    for (const row of rows) await queueImportJob(row.id, row.organization_id);
    count += rows.length;
  });
  if (count) logger.info({ count }, 'Resumed unfinished import jobs');
  return count;
}

module.exports = {
  ENTITIES, ENTITY_PERMISSION,
  createImportJob, getImportJob, listImportJobs, processImportJob, resumeImportJobs,
};
