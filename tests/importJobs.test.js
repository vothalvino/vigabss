'use strict';
// =============================================================================
// CSV imports run as background jobs (migration 522)
// =============================================================================
// An import parsed and inserted up to 10,000 rows inside the web request, so
// a large file held the request for minutes, timed out at the proxy while
// rows were still going in, and left the caller unsure what was imported.
// The request now stores the CSV, queues a csv-import job and answers 202;
// the worker runs the import handler on the stored CSV, records the result
// and clears the CSV. A job interrupted mid-import is failed, never re-run.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/utils/advisoryLock', () => ({ withAdvisoryLock: jest.fn(async (_key, fn) => { await fn(); return true; }) }));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn(async () => ({})), process: jest.fn(), close: jest.fn() }));
jest.mock('../src/services/orgPrincipalService', () => ({
  resolveOrgPrincipal: jest.fn(async (_user, organizationId) => ({
    authorizationRole: 'admin', membershipRole: 'admin', organizationId: Number(organizationId),
    isInstallOperator: false, isSuperAdmin: false, hasGlobalOrganizationAccess: false,
  })),
}));

const request = require('supertest');
const jwt = require('./helpers/staffJwt');
const config = require('../src/config');
const db = require('../src/config/database');
const jobQueue = require('../src/services/jobQueueService');
const rbac = require('../src/middleware/rbac');
const importController = require('../src/controllers/importController');
const importJobService = require('../src/services/importJobService');
const app = require('../src/app');

const ORG = 1001;
const token = jwt.sign({ sub: 50, email: 'staff@isp.example', role: 'admin', orgId: ORG }, config.jwt.secret, { expiresIn: 900, algorithm: config.jwt.algorithm });
const CSV = 'name,email\nAna,ana@example.com\nBeto,beto@example.com';

let jobs;
function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM `?users`?\b/.test(sql) && !/organization_users/.test(sql)) {
      return [[{ id: 50, email: 'staff@isp.example', role: 'admin', status: 'active', organization_id: ORG }]];
    }
    if (/^\s*INSERT INTO import_jobs/.test(sql)) {
      const id = jobs.length + 1;
      jobs.push({ id, organization_id: params[0], entity: params[1], csv_payload: params[2], created_by: params[3], status: 'queued' });
      return [{ insertId: id }];
    }
    if (/FROM import_jobs WHERE id = \? AND organization_id = \?/.test(sql)) {
      const job = jobs.find(j => j.id === Number(params[0]) && j.organization_id === Number(params[1]));
      if (!job) return [[]];
      const shown = /csv_payload/.test(sql.split('FROM')[0]) ? job : (({ csv_payload, ...rest }) => rest)(job);
      return [[shown]];
    }
    if (/^\s*UPDATE import_jobs SET status = 'running'/.test(sql)) {
      const job = jobs.find(j => j.id === params[0] && j.status === 'queued');
      if (job) job.status = 'running';
      return [{ affectedRows: job ? 1 : 0 }];
    }
    if (/^\s*UPDATE import_jobs SET/.test(sql)) {
      const job = jobs.find(j => j.id === params.at(-2) && j.organization_id === params.at(-1));
      const cols = sql.match(/SET ([\s\S]*?), csv_payload = NULL/)[1].split(',').map(c => c.trim().replace(/ = \?$/, ''));
      cols.forEach((c, i) => { job[c] = params[i]; });
      job.csv_payload = null;
      return [{ affectedRows: 1 }];
    }
    if (/FROM import_jobs\s+WHERE organization_id = \? AND entity IN/.test(sql)) {
      return [jobs.filter(j => j.organization_id === params[0] && params.slice(1).includes(j.entity))];
    }
    return [[]];
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jobs = [];
  wire();
});

describe('an import request', () => {
  test('stores the CSV, queues the job and answers 202 without the CSV', async () => {
    const res = await request(app).post('/api/v1/import/clients').set('Authorization', `Bearer ${token}`).send({ csv: CSV });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ id: 1, entity: 'clients', status: 'queued' });
    expect(res.body.data).not.toHaveProperty('csv_payload');
    expect(jobs[0]).toMatchObject({ organization_id: ORG, entity: 'clients', csv_payload: CSV, created_by: 50 });
    expect(jobQueue.add).toHaveBeenCalledWith('csv-import', { jobId: 1, organizationId: ORG }, expect.objectContaining({ jobId: 'csv-import-1' }));
    // Nothing was imported in the request itself.
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients/.test(sql))).toBe(false);
  });

  test('from an uploaded file is queued the same way, without its byte-order mark', async () => {
    const res = await request(app).post('/api/v1/import/devices/upload').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(`﻿${CSV}`, 'utf8'), { filename: 'devices.csv', contentType: 'text/csv' });

    expect(res.status).toBe(202);
    expect(jobs[0]).toMatchObject({ entity: 'devices', csv_payload: CSV });
  });

  test('without a CSV is refused before a job exists', async () => {
    const res = await request(app).post('/api/v1/import/payments').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(422);
    expect(jobs).toEqual([]);
  });
});

describe('the worker', () => {
  test('runs the entity\'s handler on the stored CSV, records the result and clears the CSV', async () => {
    jobs.push({ id: 7, organization_id: ORG, entity: 'clients', csv_payload: CSV, created_by: 50, status: 'queued' });
    const handler = jest.spyOn(importController, 'importClients').mockImplementation(async (req, res) => {
      res.json({ data: { imported: 1, total: 2, errors: [{ row: 3, error: 'name is required' }] } });
    });

    await importJobService.processImportJob(7, ORG);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, user: { id: 50 }, body: { csv: CSV } }), expect.anything(), expect.any(Function),
    );
    expect(jobs[0]).toMatchObject({
      status: 'completed', total_rows: 2, imported_rows: 1, csv_payload: null,
      row_errors: JSON.stringify([{ row: 3, error: 'name is required' }]),
    });
  });

  test('fails a job it finds already running instead of importing it twice', async () => {
    jobs.push({ id: 8, organization_id: ORG, entity: 'payments', csv_payload: CSV, created_by: 50, status: 'running' });
    const handler = jest.spyOn(importController, 'importPayments');

    await importJobService.processImportJob(8, ORG);

    expect(handler).not.toHaveBeenCalled();
    expect(jobs[0]).toMatchObject({ status: 'failed', csv_payload: null });
    expect(jobs[0].error_message).toMatch(/Interrupted[\s\S]*check before importing the file again/);
  });

  test('records a refusal or a crash as a failed job, CSV cleared', async () => {
    jobs.push({ id: 9, organization_id: ORG, entity: 'invoices', csv_payload: CSV, created_by: 50, status: 'queued' });
    jest.spyOn(importController, 'importInvoices').mockImplementation(async (_req, _res, next) => next(new Error('database went away')));

    await importJobService.processImportJob(9, ORG);

    expect(jobs[0]).toMatchObject({ status: 'failed', error_message: 'database went away', csv_payload: null });
  });

  test('leaves a finished job alone', async () => {
    jobs.push({ id: 10, organization_id: ORG, entity: 'clients', csv_payload: null, created_by: 50, status: 'completed' });
    const handler = jest.spyOn(importController, 'importClients');
    await importJobService.processImportJob(10, ORG);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the job status', () => {
  test('is the caller organization\'s only', async () => {
    jobs.push({ id: 11, organization_id: 2002, entity: 'clients', csv_payload: CSV, created_by: 9, status: 'queued' });
    const res = await request(app).get('/api/v1/import/jobs/11').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  test('needs the permission to import that entity', async () => {
    jobs.push({ id: 12, organization_id: ORG, entity: 'payments', csv_payload: null, created_by: 50, status: 'completed' });
    jest.spyOn(rbac, 'userHasPermission').mockImplementation(async (_req, permission) => permission !== 'payments.create');

    const res = await request(app).get('/api/v1/import/jobs/12').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);

    const list = await request(app).get('/api/v1/import/jobs').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const [, params] = db.query.mock.calls.find(([sql]) => /entity IN/.test(sql));
    expect(params).toEqual([ORG, 'clients', 'devices', 'contracts', 'invoices']);
  });

  test('shows the result and never the CSV', async () => {
    jobs.push({ id: 13, organization_id: ORG, entity: 'clients', csv_payload: CSV, created_by: 50, status: 'queued' });
    const res = await request(app).get('/api/v1/import/jobs/13').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 13, status: 'queued', row_errors: [] });
    expect(res.body.data).not.toHaveProperty('csv_payload');
  });
});

describe('a restart', () => {
  test('queues every unfinished import again', async () => {
    const fanOut = require('../src/services/organizationFanOut');
    jest.spyOn(fanOut, 'forEachDatabaseScope').mockImplementation(async (_name, fn) => fn(null));
    jest.spyOn(fanOut, 'orgScopeFilter').mockReturnValue({ sql: '', params: [] });
    db.query.mockImplementation(async (sql) => (/status IN \('queued','running'\)/.test(sql)
      ? [[{ id: 3, organization_id: ORG }, { id: 4, organization_id: ORG }]]
      : [[]]));

    expect(await importJobService.resumeImportJobs()).toBe(2);
    expect(jobQueue.add).toHaveBeenCalledWith('csv-import', { jobId: 3, organizationId: ORG }, expect.anything());
    expect(jobQueue.add).toHaveBeenCalledWith('csv-import', { jobId: 4, organizationId: ORG }, expect.anything());
  });
});
