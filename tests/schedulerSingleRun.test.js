// =============================================================================
// ASY-01 — without Redis, each scheduled task runs once per tick across replicas
// =============================================================================
// The no-Redis lock was a get-then-set in a per-process memory cache, so with
// two or more replicas (the shipped k8s/Helm default) every replica ran every
// task: autopay, payment retries, SNMP polling. A MySQL advisory lock per task
// id and a per-minute claim on the task row now decide which process runs it.
// =============================================================================

const fs = require('fs');
const path = require('path');

// One shared "database": an advisory-lock table and the task row.
const locks = new Map();
const taskRow = { last_run_minute: null };
let currentMinute = '2026-10-31 07:00';
let nextConn = 0;

function mockMakeConnection() {
  const id = ++nextConn;
  return {
    id,
    query: jest.fn(async (sql, params = []) => {
      if (/GET_LOCK/.test(sql)) {
        const holder = locks.get(params[0]);
        if (holder && holder !== id) return [[{ acquired: 0 }]];
        locks.set(params[0], id);
        return [[{ acquired: 1 }]];
      }
      if (/RELEASE_LOCK/.test(sql)) {
        const ok = locks.get(params[0]) === id;
        if (ok) locks.delete(params[0]);
        return [[{ released: ok ? 1 : 0 }]];
      }
      if (/UPDATE scheduled_tasks\s+SET last_status = 'running', last_run_at = NOW\(\)/.test(sql)) {
        if (taskRow.last_run_minute !== null && taskRow.last_run_minute >= currentMinute) return [{ affectedRows: 0 }];
        taskRow.last_run_minute = currentMinute;
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    }),
    release: jest.fn(),
    destroy: jest.fn(),
  };
}

jest.mock('../src/config/database', () => ({
  query: jest.fn(async () => [{ affectedRows: 1 }]),
  getConnection: jest.fn(async () => mockMakeConnection()),
  baseConnectionConfig: { database: 'vigabss_test' },
}));

const { runClaimed } = require('../src/services/scheduler');

const TASK = { id: 31, task_name: 'process_recurring_charges', organization_id: null };

beforeEach(() => {
  locks.clear();
  taskRow.last_run_minute = null;
  currentMinute = '2026-10-31 07:00';
});

test('two replicas firing the same tick run the task once', async () => {
  const charge = jest.fn(async () => {});
  const results = await Promise.all([runClaimed(TASK, charge), runClaimed(TASK, charge)]);
  expect(charge).toHaveBeenCalledTimes(1);
  expect(results.sort()).toEqual([false, true]);
});

test('the next minute runs again', async () => {
  const run = jest.fn(async () => {});
  await runClaimed(TASK, run);
  currentMinute = '2026-10-31 07:01';
  await runClaimed(TASK, run);
  expect(run).toHaveBeenCalledTimes(2);
});

test('a run still going blocks the next tick instead of overlapping it', async () => {
  let finish;
  const slow = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const first = runClaimed(TASK, slow);
  await new Promise(r => setImmediate(r));
  currentMinute = '2026-10-31 07:01';
  expect(await runClaimed(TASK, slow)).toBe(false);
  finish();
  expect(await first).toBe(true);
  expect(slow).toHaveBeenCalledTimes(1);
});

test('the lock is released when the task throws', async () => {
  await expect(runClaimed(TASK, async () => { throw new Error('gateway down'); })).rejects.toThrow('gateway down');
  expect(locks.size).toBe(0);
});

test('shipped manifests run one replica unless Redis is configured', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  expect(read('k8s/deployment.yaml')).toMatch(/^\s+replicas: 1$/m);
  expect(read('k8s/hpa.yaml')).toMatch(/maxReplicas: 1$/m);
  const values = read('charts/fireisp/values.yaml');
  expect(values).toMatch(/^replicaCount: 1$/m);
  expect(values).toMatch(/^hpa:\n {2}enabled: false$/m);
  expect(read('charts/fireisp/templates/deployment.yaml')).toMatch(/fail "More than one replica/);
});
