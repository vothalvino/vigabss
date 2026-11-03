// =============================================================================
// DAL-13 — /export streams CSV in keyset batches
// =============================================================================
// The four exports ran one unbounded org-wide SELECT and built the whole file
// as one string before res.send, in the process that also serves RADIUS. They
// now read LIMIT-ed batches by id, write each as it arrives and wait for the
// client to drain.
// =============================================================================

const { EventEmitter } = require('events');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const db = require('../src/config/database');
const exportController = require('../src/controllers/exportController');

const { BATCH_SIZE } = exportController;

function fakeRes({ backpressure = false } = {}) {
  const res = new EventEmitter();
  res.chunks = [];
  res.headers = {};
  res.destroyed = false;
  res.ended = false;
  res.set = jest.fn((k, v) => { res.headers[k] = v; return res; });
  res.send = jest.fn();
  res.write = jest.fn((chunk) => {
    res.chunks.push(chunk);
    if (!backpressure) return true;
    setImmediate(() => res.emit('drain'));
    return false;
  });
  res.end = jest.fn(() => { res.ended = true; });
  res.destroy = jest.fn(() => { res.destroyed = true; });
  return res;
}

function clients(fromId, count) {
  return Array.from({ length: count }, (_, i) => ({ id: fromId - i, name: `Client ${fromId - i}`, email: null }));
}

const req = { orgId: 7, query: {}, user: { id: 3 }, ip: '10.0.0.1', get: () => 'jest' };

beforeEach(() => jest.clearAllMocks());

function answer(total, batches) {
  db.query.mockImplementation(async (sql) => {
    if (/COUNT\(\*\)/.test(sql)) return [[{ total }]];
    if (/INSERT INTO report_access_logs/.test(sql)) return [{ insertId: 1 }];
    return [batches.shift() || []];
  });
}

describe('DAL-13: streamed CSV exports', () => {
  test('rows are read in LIMIT-ed keyset batches and written as they arrive', async () => {
    answer(2500, [clients(5000, BATCH_SIZE), clients(4000, BATCH_SIZE), clients(3000, 500)]);
    const res = fakeRes();
    const next = jest.fn();

    await exportController.exportClients(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const selects = db.query.mock.calls.filter(([sql]) => /^SELECT cl\.id/.test(sql.trim()));
    expect(selects).toHaveLength(3);
    for (const [sql] of selects) expect(sql).toMatch(new RegExp(`ORDER BY cl\\.id DESC\\s+LIMIT ${BATCH_SIZE}`));
    // Each batch continues below the last id of the previous one.
    expect(selects[0][1]).toEqual([7]);
    expect(selects[1][1]).toEqual([7, 4001]);
    expect(selects[2][1]).toEqual([7, 3001]);

    expect(res.send).not.toHaveBeenCalled();
    // Header plus one write per batch: never the whole file at once.
    expect(res.write).toHaveBeenCalledTimes(4);
    expect(res.ended).toBe(true);
    const csv = res.chunks.join('');
    expect(csv.split('\n')).toHaveLength(2501);
    expect(csv.split('\n')[0]).toBe('id,name,email,phone,status,locale,country,city,state,created_at');
  });

  test('waits for the client to drain before reading the next batch', async () => {
    answer(1500, [clients(2000, BATCH_SIZE), clients(1000, 500)]);
    const res = fakeRes({ backpressure: true });
    const order = [];
    const realQuery = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => { order.push('query'); return realQuery(sql, params); });
    res.on('drain', () => order.push('drain'));

    await exportController.exportClients(req, res, jest.fn());

    // count, log, [header drain], batch 1, drain, batch 2, drain
    expect(order).toEqual(['query', 'query', 'drain', 'query', 'drain', 'query', 'drain']);
  });

  test('stops reading once the client has gone away', async () => {
    answer(5000, [clients(5000, BATCH_SIZE), clients(4000, BATCH_SIZE)]);
    const res = fakeRes();
    res.write.mockImplementation((chunk) => {
      res.chunks.push(chunk);
      if (res.chunks.length === 2) res.destroyed = true;
      return true;
    });

    await exportController.exportClients(req, res, jest.fn());

    expect(db.query.mock.calls.filter(([sql]) => /^SELECT cl\.id/.test(sql.trim()))).toHaveLength(1);
  });

  test('a failure after the header destroys the response instead of ending a cut-off file', async () => {
    let selects = 0;
    db.query.mockImplementation(async (sql) => {
      if (/COUNT\(\*\)/.test(sql)) return [[{ total: 3000 }]];
      if (/INSERT INTO report_access_logs/.test(sql)) return [{}];
      selects += 1;
      if (selects === 2) throw new Error('connection lost');
      return [clients(3000, BATCH_SIZE)];
    });
    const res = fakeRes();
    const next = jest.fn();

    await exportController.exportInvoices(req, res, next);

    expect(res.destroy).toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('the export is logged with its row count before any row is written', async () => {
    answer(2, [clients(2, 2)]);
    const res = fakeRes();
    const firstWrite = [];
    res.write.mockImplementation((chunk) => { firstWrite.push(db.query.mock.calls.length); res.chunks.push(chunk); return true; });

    await exportController.exportPayments(req, res, jest.fn());

    const logIndex = db.query.mock.calls.findIndex(([sql]) => /INSERT INTO report_access_logs/.test(sql));
    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(firstWrite[0]).toBeGreaterThan(logIndex);
    expect(JSON.parse(db.query.mock.calls[logIndex][1][4])).toEqual({ include_deleted: false, row_count: 2 });
  });

  test('an empty export still has its header row', async () => {
    answer(0, []);
    const res = fakeRes();
    await exportController.exportContracts(req, res, jest.fn());
    expect(res.chunks.join('')).toBe('id,client_id,name,plan_name,status,connection_type,start_date,end_date,price_override,plan_price,currency');
  });
});
