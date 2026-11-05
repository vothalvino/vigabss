'use strict';
// =============================================================================
// Monitoring: background job queue depth and RADIUS accounting
// =============================================================================
// Nothing exported how many background jobs were waiting, so a stopped or
// overloaded worker showed up only as late emails and webhooks; RADIUS
// accounting had no metric of its own, so a NAS whose accounting was being
// rejected looked the same as one that was idle. /metrics now reads the
// queue's counts when scraped (job_queue_jobs{queue,state}, bounded so a slow
// Redis cannot hold the scrape) and counts accounting requests by status type
// and result (radius_accounting_requests_total).
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue([[{ ts: null }]]) }));

const request = require('supertest');
const express = require('express');
const jobQueue = require('../src/services/jobQueueService');
const ops = require('../src/utils/opsMetrics');
const metrics = require('../src/routes/metrics');

function scrape() {
  const app = express();
  app.use('/metrics', metrics.router);
  return request(app).get('/metrics');
}

const series = (text, name) => text.split('\n').filter(l => l.startsWith(`${name}{`) || l.startsWith(`${name} `));

beforeEach(() => {
  jest.restoreAllMocks();
  ops.noteQueueDepth([]);
  delete process.env.METRICS_TOKEN;
});

describe('job_queue_jobs', () => {
  test('reports every queue\'s waiting, active, delayed and failed jobs at scrape time', async () => {
    jest.spyOn(jobQueue, 'getStats').mockResolvedValue({
      mode: 'bullmq',
      queues: [
        { name: 'webhook-delivery', waiting: 42, active: 3, completed: 900, failed: 2, delayed: 1 },
        { name: 'csv-import', waiting: 0, active: 1, completed: 4, failed: 0, delayed: 0 },
      ],
    });
    const res = await scrape();
    expect(res.status).toBe(200);
    const lines = series(res.text, 'job_queue_jobs');
    expect(lines).toEqual(expect.arrayContaining([
      'job_queue_jobs{queue="webhook-delivery",state="waiting"} 42',
      'job_queue_jobs{queue="webhook-delivery",state="active"} 3',
      'job_queue_jobs{queue="webhook-delivery",state="failed"} 2',
      'job_queue_jobs{queue="csv-import",state="active"} 1',
    ]));
    // Completed jobs are history, not depth.
    expect(lines.some(l => /state="completed"/.test(l))).toBe(false);
  });

  test('takes the in-process queue\'s counts too, active included', async () => {
    const stats = await jobQueue.getStats();
    expect(stats).toMatchObject({ mode: expect.any(String) });
    ops.noteQueueDepth([{ name: 'message-outbox', waiting: 5, active: 2 }]);
    const lines = series(metrics.registry.render(), 'job_queue_jobs');
    expect(lines).toEqual([
      'job_queue_jobs{queue="message-outbox",state="waiting"} 5',
      'job_queue_jobs{queue="message-outbox",state="active"} 2',
    ]);
  });

  // Real timers: the scrape goes through supertest's real sockets. The
  // deadline is 2 s.
  test('keeps the last counts when the queue does not answer in time', async () => {
    ops.noteQueueDepth([{ name: 'batch-job', waiting: 7 }]);
    jest.spyOn(jobQueue, 'getStats').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const res = await scrape();
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(series(res.text, 'job_queue_jobs')).toEqual(['job_queue_jobs{queue="batch-job",state="waiting"} 7']);
  }, 10000);

  test('every queue the workers register is in the stats list', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/workers/index.js'), 'utf8');
    const registered = [...src.matchAll(/jobQueue\.process\('([a-z-]+)'/g)].map(m => m[1]);
    const listed = require('fs').readFileSync(require('path').join(__dirname, '../src/services/jobQueueService.js'), 'utf8')
      .match(/const QUEUE_NAMES = \[([^\]]*)\]/)[1];
    for (const name of registered) expect([name, listed.includes(`'${name}'`)]).toEqual([name, true]);
  });
});

describe('radius_accounting_requests_total', () => {
  test('counts by status type and result, with unknown types as other', () => {
    ops.noteRadiusAccounting('Start', 200);
    ops.noteRadiusAccounting('Interim-Update', 422);
    ops.noteRadiusAccounting('Stop', 401);
    ops.noteRadiusAccounting('Stop', 500);
    ops.noteRadiusAccounting('<script>', 400);
    const lines = series(metrics.registry.render(), 'radius_accounting_requests_total');
    expect(lines).toEqual(expect.arrayContaining([
      'radius_accounting_requests_total{status_type="Start",result="accepted"} 1',
      'radius_accounting_requests_total{status_type="Interim-Update",result="rejected"} 1',
      'radius_accounting_requests_total{status_type="Stop",result="unauthorized"} 1',
      'radius_accounting_requests_total{status_type="Stop",result="error"} 1',
      'radius_accounting_requests_total{status_type="other",result="rejected"} 1',
    ]));
  });
  // The route that records it: tests/radiusTenantAccounting.test.js.
});
