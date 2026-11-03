'use strict';
// =============================================================================
// ASY-33 — a campaign message's outbox outcome lands on the campaign
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));
const mockHandlers = new Map();
const mockCancelQueuedBySource = jest.fn(async () => 2);
jest.mock('../src/services/messageOutbox', () => ({
  onOutcome: (type, fn) => mockHandlers.set(type, fn),
  cancelQueuedBySource: (...a) => mockCancelQueuedBySource(...a),
}));

const db = require('../src/config/database');
require('../src/services/outboxOutcomeHandlers');
const { HANDED_OFF, DELIVERY_OUTCOME_UNKNOWN } = require('../src/services/campaignService');

const row = { id: 900, organization_id: 4, source_type: 'campaign_message', source_id: 31, channel: 'email' };
const handle = outcome => mockHandlers.get('campaign_message')(row, outcome);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue([{ affectedRows: 1 }]);
});

test('a delivered message is sent, keeps the provider id for delivery callbacks, and counts as sent', async () => {
  await handle({ status: 'sent', providerMessageId: 'SM-1' });

  const [update, counter] = db.query.mock.calls;
  expect(update[0]).toMatch(/SET status = \?, sent_at = NOW\(\), provider_message_id = \?/);
  expect(update[1]).toEqual(['sent', 'SM-1', null, 31, 4, HANDED_OFF]);
  expect(counter[0]).toMatch(/sent_count = cc\.sent_count \+ 1/);
});

test('an unknown outcome keeps the marker that blocks a duplicate redispatch', async () => {
  await handle({ status: 'outcome_unknown', providerMessageId: null, code: 'DELIVERY_OUTCOME_UNKNOWN' });

  expect(db.query.mock.calls[0][1]).toEqual(['failed', null, DELIVERY_OUTCOME_UNKNOWN, 31, 4, HANDED_OFF]);
  expect(db.query.mock.calls[1][0]).toMatch(/failed_count = cc\.failed_count \+ 1/);
});

test('a message no longer handed off (already recorded) is not counted twice', async () => {
  db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
  await handle({ status: 'failed', error: 'gave up' });
  expect(db.query).toHaveBeenCalledTimes(1);
});
