// =============================================================================
// VigaBSS 5.0 — §4 AI Background Workers Tests
// =============================================================================
// Covers all three AI BullMQ workers registered in src/workers/index.js:
//   • ai-triage              (aiTriageWorker)
//   • ai-backfill-embeddings (aiBackfillEmbeddingsWorker)
//   • ai-cost-rollup         (aiCostRollupWorker)
//
// All external I/O is mocked; no Redis or DB required.
// =============================================================================

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const mockDbQuery = jest.fn();
jest.mock('../../src/config/database', () => ({ query: mockDbQuery }));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeJob(data = {}) {
  return { id: `test-${Date.now()}`, data };
}

// ---------------------------------------------------------------------------
// Extract registered handler for a named queue
// ---------------------------------------------------------------------------
function getHandler(jobQueue, name) {
  const call = jobQueue.process.mock.calls.find(([n]) => n === name);
  if (!call) throw new Error(`No handler registered for queue "${name}"`);
  return call[1];
}

// =============================================================================
// 1. ai-triage worker
// =============================================================================

describe('aiTriageWorker (ai-triage)', () => {
  const mockGenerate = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGenerate.mockReset();
    jest.mock('../../src/services/aiReplyService', () => ({ generate: mockGenerate }));
    jest.mock('../../src/services/jobQueueService', () => ({
      add:      jest.fn().mockResolvedValue({ id: 'x' }),
      process:  jest.fn(),
      close:    jest.fn(),
      getStats: jest.fn(),
      QUEUE_NAMES: [],
    }));
  });

  it('delegates to aiReplyService.generate with all job data fields', async () => {
    mockGenerate.mockResolvedValue({ skipped: false, logId: 1, action: 'proposed' });

    const jobQueue = require('../../src/services/jobQueueService');
    const workers  = require('../../src/workers');
    workers.registerWorkers();

    const handler = getHandler(jobQueue, 'ai-triage');
    const result = await handler(makeJob({
      orgId: 1, ticketId: 10, channel: 'portal', inboundText: 'Internet down', contractId: 5,
    }));

    expect(mockGenerate).toHaveBeenCalledWith({
      orgId: 1, ticketId: 10, channel: 'portal', inboundText: 'Internet down', contractId: 5,
    });
    expect(result).toMatchObject({ logId: 1, action: 'proposed' });
  });

  it('returns { skipped: true } when policy is disabled', async () => {
    mockGenerate.mockResolvedValue({ skipped: true, reason: 'policy_disabled' });

    const jobQueue = require('../../src/services/jobQueueService');
    const workers  = require('../../src/workers');
    workers.registerWorkers();

    const handler = getHandler(jobQueue, 'ai-triage');
    const result = await handler(makeJob({ orgId: 2, ticketId: 3, channel: 'portal', inboundText: 'x' }));

    expect(result).toEqual({ skipped: true, reason: 'policy_disabled' });
  });

  it('returns { skipped: true } when channel is not enabled', async () => {
    mockGenerate.mockResolvedValue({ skipped: true, reason: 'channel_disabled' });

    const jobQueue = require('../../src/services/jobQueueService');
    const workers  = require('../../src/workers');
    workers.registerWorkers();

    const handler = getHandler(jobQueue, 'ai-triage');
    const result = await handler(makeJob({ orgId: 1, ticketId: 5, channel: 'sms', inboundText: 'x' }));

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('channel_disabled');
  });
});

// =============================================================================
// 2. ai-backfill-embeddings worker
// =============================================================================

// ai-backfill-embeddings and ai-cost-rollup were removed (ASY-34): nothing
// ever enqueued them, so their handlers and these tests covered dead code.

describe('QUEUE_NAMES — AI queues registered', () => {
  it('contains ai-triage, and no longer the queues nothing enqueued', () => {
    const { QUEUE_NAMES } = jest.requireActual('../../src/services/jobQueueService');
    expect(QUEUE_NAMES).toContain('ai-triage');
    expect(QUEUE_NAMES).not.toContain('ai-backfill-embeddings');
    expect(QUEUE_NAMES).not.toContain('ai-cost-rollup');
  });
});
