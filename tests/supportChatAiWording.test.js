// Which replies the AI may word: ordinary answers, yes; a hand-off to a person
// or a request to confirm an action stays exactly as the rules wrote it.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});
jest.mock('../src/services/businessEvents', () => ({ emitTicketCreated: jest.fn().mockResolvedValue(undefined) }));
const mockWrite = jest.fn();
jest.mock('../src/services/supportAiWriter', () => ({ writeReply: (...a) => mockWrite(...a) }));

const db = require('../src/config/database');
const service = require('../src/services/supportConversationService');

beforeEach(() => {
  jest.clearAllMocks();
  mockWrite.mockResolvedValue('Con gusto. ¿Sobre qué necesitas información?');
  db.query.mockImplementation(async (sql) => {
    if (/FROM ai_providers/.test(sql)) return [[]];
    if (/INSERT INTO support_conversations/.test(sql)) return [{ insertId: 1 }];
    if (/SET status = 'escalated'/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM support_conversations/.test(sql)) return [[{ id: 1, organization_id: 3, client_id: 10, status: 'open', channel: 'whatsapp', ticket_id: null }]];
    if (/COUNT/.test(sql)) return [[{ cnt: 0 }]];
    if (/FROM support_messages/.test(sql)) return [[]];
    if (/INSERT INTO tickets/.test(sql)) return [{ insertId: 9 }];
    return [{ insertId: 5, affectedRows: 1 }];
  });
});

const assistantReply = () => db.query.mock.calls
  .filter(([sql, p]) => /INSERT INTO support_messages/.test(sql) && p.includes('assistant'))
  .map(([, p]) => p[2])[0];

test('an ordinary reply is worded by the AI, from the rule-based text, on the conversation\'s channel', async () => {
  await service.startConversation({ orgId: 3, clientId: 10, channel: 'whatsapp', message: 'hola buenas' });
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockWrite.mock.calls[0][0]).toMatchObject({ orgId: 3, conversationId: 1, channel: 'whatsapp', customerMessage: 'hola buenas' });
  expect(mockWrite.mock.calls[0][0].ruleReply).toMatch(/^Soy tu asistente virtual/);
  expect(assistantReply()).toBe('Con gusto. ¿Sobre qué necesitas información?');
});

test('when the writer declines, the rule-based reply is sent', async () => {
  mockWrite.mockResolvedValue(null);
  await service.startConversation({ orgId: 3, clientId: 10, channel: 'whatsapp', message: 'hola buenas' });
  expect(assistantReply()).toMatch(/^Soy tu asistente virtual/);
});

test('follow-up messages use the stored conversation\'s channel', async () => {
  await service.sendMessage({ conversationId: 1, orgId: 3, content: 'hola otra vez' });
  expect(mockWrite.mock.calls[0][0]).toMatchObject({ channel: 'whatsapp', conversationId: 1 });
});
