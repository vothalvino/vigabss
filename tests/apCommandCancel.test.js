// =============================================================================
// NET-22 — cancelling an AP command job is conditional on its state
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const wirelessService = require('../src/services/wirelessService');

beforeEach(() => jest.clearAllMocks());

test('the cancel UPDATE is scoped to the org and to a still-pending job', async () => {
  db.query
    .mockResolvedValueOnce([[{ id: 5, organization_id: 2, status: 'pending' }]]) // read
    .mockResolvedValueOnce([{ affectedRows: 1 }])                                 // cancel
    .mockResolvedValueOnce([[{ id: 5, organization_id: 2, status: 'cancelled' }]]);

  const job = await wirelessService.cancelApCommandJob(5, 2);
  expect(job.status).toBe('cancelled');
  const [sql, params] = db.query.mock.calls[1];
  expect(sql).toMatch(/WHERE id = \? AND organization_id <=> \? AND status IN \('pending', 'queued'\)/);
  expect(params).toEqual([5, 2]);
});

test('a job that started running between the read and the update is not cancelled', async () => {
  db.query
    .mockResolvedValueOnce([[{ id: 5, organization_id: 2, status: 'pending' }]])
    .mockResolvedValueOnce([{ affectedRows: 0 }]);
  await expect(wirelessService.cancelApCommandJob(5, 2)).rejects.toMatchObject({ statusCode: 409 });
});
