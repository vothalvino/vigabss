// The AI chat classified every message by keyword only: both call sites passed
// no provider, so a configured model was never asked. A message outside the
// keyword lists ("cuanto debo") scored as unclear, and two unclear messages
// escalate the conversation to a person — the chat looked broken with a
// working provider connected.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});
jest.mock('../src/services/businessEvents', () => ({ emitTicketCreated: jest.fn().mockResolvedValue(undefined) }));
const mockChat = jest.fn();
jest.mock('../src/services/llmProviderService', () => ({ chat: (...args) => mockChat(...args) }));

const db = require('../src/config/database');
const service = require('../src/services/supportConversationService');

let providerRows;

beforeEach(() => {
  jest.clearAllMocks();
  providerRows = [{ id: 7 }];
  db.query.mockImplementation(async (sql) => {
    if (/FROM ai_providers/.test(sql)) return [providerRows];
    if (/INSERT INTO support_conversations/.test(sql)) return [{ insertId: 1 }];
    if (/FROM support_conversations/.test(sql)) return [[{ id: 1, organization_id: 3, client_id: 10, status: 'open', ticket_id: null }]];
    if (/COUNT/.test(sql)) return [[{ cnt: 0 }]];
    if (/FROM support_messages/.test(sql)) return [[]];
    return [{ insertId: 5, affectedRows: 1 }];
  });
  mockChat.mockResolvedValue({ json: { intent: 'billing', confidence: 0.93, entities: {} } });
});

const conversationInsert = () => db.query.mock.calls.find(([sql]) => /INSERT INTO support_conversations/.test(sql));
const customerMessage = () => db.query.mock.calls
  .find(([sql, p]) => /INSERT INTO support_messages/.test(sql) && p.includes('customer'));

test('a message the keywords cannot place is classified by the organization\'s provider', async () => {
  await service.startConversation({ orgId: 3, clientId: 10, message: 'cuanto debo' });
  expect(mockChat).toHaveBeenCalledTimes(1);
  expect(mockChat.mock.calls[0][0]).toMatchObject({ providerId: 7, orgId: 3 });
  const [, params] = conversationInsert();
  expect(params).toEqual(expect.arrayContaining(['billing', 0.93]));
});

test('the provider is looked up within the organization', async () => {
  await service.startConversation({ orgId: 3, clientId: 10, message: 'cuanto debo' });
  const [sql, params] = db.query.mock.calls.find(([q]) => /FROM ai_providers/.test(q));
  expect(sql).toMatch(/organization_id = \?/);
  expect(params).toEqual([3]);
});

test('a message the keywords do place costs no provider call', async () => {
  await service.startConversation({ orgId: 3, clientId: 10, message: 'no tengo internet' });
  expect(mockChat).not.toHaveBeenCalled();
  expect(db.query.mock.calls.some(([sql]) => /FROM ai_providers/.test(sql))).toBe(false);
});

test('with no provider configured the keyword result stands', async () => {
  providerRows = [];
  await service.startConversation({ orgId: 3, clientId: 10, message: 'cuanto debo' });
  expect(mockChat).not.toHaveBeenCalled();
  expect(conversationInsert()[1]).toEqual(expect.arrayContaining(['other', 0.5]));
});

test('a failed provider call falls back to the keyword result instead of failing the chat', async () => {
  mockChat.mockRejectedValue(new Error('upstream timeout'));
  await service.startConversation({ orgId: 3, clientId: 10, message: 'cuanto debo' });
  expect(conversationInsert()[1]).toEqual(expect.arrayContaining(['other', 0.5]));
});

test('follow-up messages are classified the same way', async () => {
  await service.sendMessage({ conversationId: 1, orgId: 3, content: 'cuanto debo' });
  expect(mockChat).toHaveBeenCalledTimes(1);
  expect(customerMessage()[1]).toEqual(expect.arrayContaining(['billing', 0.93]));
});
