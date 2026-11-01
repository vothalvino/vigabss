// =============================================================================
// VigaBSS 5.0 — Prometheus Metrics Tests
// =============================================================================

const { metricsMiddleware, httpRequests, httpErrors, registry } = require('../src/routes/metrics');
const { recordDbQuery, dbQueryDuration } = require('../src/utils/dbMetrics');

function run(req, statusCode) {
  const res = {
    statusCode,
    on: jest.fn((event, handler) => {
      if (event === 'finish') handler();
    }),
  };
  const next = jest.fn();
  metricsMiddleware(req, res, next);
  return next;
}

const count = (labels) => dbQueryDuration.series.map.get(dbQueryDuration.series.key(labels).key)?.count || 0;

describe('Prometheus Metrics', () => {
  beforeEach(() => {
    httpRequests.reset();
    httpErrors.reset();
    dbQueryDuration.reset();
  });

  describe('metricsMiddleware()', () => {
    it('counts the request by method, route and status', () => {
      const next = run({ method: 'GET', path: '/api/clients', route: null }, 200);
      expect(next).toHaveBeenCalled();
      expect(httpRequests.get({ method: 'GET', path: 'unmatched', status: '200' })).toBe(1);
    });

    it('increments the error counter for 4xx/5xx', () => {
      run({ method: 'GET', path: '/api/notfound', route: null }, 404);
      expect(httpErrors.get({ method: 'GET', path: 'unmatched', status: '404' })).toBe(1);
    });

    it('does not increment the error counter for 2xx', () => {
      run({ method: 'POST', path: '/api/clients', route: { path: '/clients' } }, 201);
      expect(httpErrors.lines()).toEqual([]);
      expect(httpRequests.get({ method: 'POST', path: '/clients', status: '201' })).toBe(1);
    });
  });

  describe('recordDbQuery()', () => {
    it('records a DB query for a given operation', () => {
      recordDbQuery(0.012, 'SELECT');
      expect(count({ operation: 'SELECT' })).toBe(1);
      expect(registry.render()).toMatch(/^db_query_duration_seconds_bucket\{operation="SELECT",le="0.025"\} 1$/m);
    });

    it('defaults operation to OTHER when not provided', () => {
      recordDbQuery(0.005);
      expect(count({ operation: 'OTHER' })).toBe(1);
    });

    it('tracks each operation separately', () => {
      recordDbQuery(0.010, 'SELECT');
      recordDbQuery(0.020, 'INSERT');
      recordDbQuery(0.015, 'UPDATE');
      recordDbQuery(0.008, 'DELETE');
      for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(count({ operation: op })).toBe(1);
    });

    it('keeps counting past any sample window: the count only grows', () => {
      for (let i = 0; i < 2001; i++) recordDbQuery(i * 0.0001, 'SELECT');
      expect(count({ operation: 'SELECT' })).toBe(2001);
    });
  });
});
