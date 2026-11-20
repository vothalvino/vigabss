// An escalated AI chat opens a ticket. The ticket used to say only
// "Escalated from AI support conversation #N", so the agent picking it up
// could not see what the customer had written without finding the chat on
// another page. The ticket now carries the conversation so far.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});
jest.mock('../src/services/businessEvents', () => ({ emitTicketCreated: jest.fn().mockResolvedValue(undefined) }));

const db = require('../src/config/database');
const service = require('../src/services/supportConversationService');

let messages;
let failTranscript;

beforeEach(() => {
  jest.clearAllMocks();
  failTranscript = false;
  messages = [
    { role: 'customer', content: 'No tengo internet desde ayer', created_at: '2026-01-01 10:00:00' },
    { role: 'assistant', content: 'Soy tu asistente virtual. Revisemos tu servicio.', created_at: '2026-01-01 10:00:05' },
    { role: 'customer', content: 'Quiero hablar con una persona', created_at: '2026-01-01 10:01:00' },
  ];
  db.query.mockImplementation(async (sql) => {
    if (/SET status = 'escalated'/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM support_messages sm/.test(sql)) {
      if (failTranscript) throw new Error('ER_LOCK_WAIT_TIMEOUT');
      return [messages];
    }
    if (/INSERT INTO tickets/.test(sql)) return [{ insertId: 77 }];
    if (/FROM support_conversations/.test(sql)) return [[{ id: 5, organization_id: 3, status: 'escalated', ticket_id: 77 }]];
    if (/FROM support_messages/.test(sql)) return [messages];
    return [{ insertId: 9, affectedRows: 1 }];
  });
});

const ticketInsert = () => db.query.mock.calls.find(([sql]) => /INSERT INTO tickets/.test(sql));
const transcriptRead = () => db.query.mock.calls.find(([sql]) => /FROM support_messages sm/.test(sql));

test('the escalation ticket carries the reason and the conversation so far', async () => {
  await service.escalate({ conversationId: 5, reason: 'human_requested', orgId: 3 });
  const [, params] = ticketInsert();
  expect(params[0]).toBe([
    'Escalated from AI support conversation #5. Reason: human_requested',
    '',
    'Conversation so far:',
    'Customer: No tengo internet desde ayer',
    'Assistant: Soy tu asistente virtual. Revisemos tu servicio.',
    'Customer: Quiero hablar con una persona',
  ].join('\n'));
  expect(params.slice(1)).toEqual([5, 3]);
});

test('the transcript is read through the conversation of that organization', async () => {
  await service.escalate({ conversationId: 5, reason: 'manual', orgId: 3 });
  const [sql, params] = transcriptRead();
  expect(sql).toMatch(/JOIN support_conversations sc ON sc\.id = sm\.conversation_id/);
  expect(sql).toMatch(/sc\.organization_id = \?/);
  expect(params).toEqual([5, 3]);
});

test('a long conversation keeps its latest messages and says how many were left out', async () => {
  messages = Array.from({ length: 40 }, (_, i) => ({ role: 'customer', content: `mensaje ${i + 1} ${'x'.repeat(990)}` }));
  await service.escalate({ conversationId: 5, reason: 'manual', orgId: 3 });
  const description = ticketInsert()[1][0];
  expect(description.length).toBeLessThan(16000);
  expect(description).toMatch(/\(\d+ earlier messages not shown\)/);
  expect(description).toContain('mensaje 40 ');
  expect(description).not.toContain('mensaje 1 ');
});

test('the ticket is still created when the transcript cannot be read', async () => {
  failTranscript = true;
  await service.escalate({ conversationId: 5, reason: 'manual', orgId: 3 });
  expect(ticketInsert()[1][0]).toBe('Escalated from AI support conversation #5. Reason: manual');
});

test('a conversation with no messages yet gets the plain description', async () => {
  messages = [];
  await service.escalate({ conversationId: 5, reason: 'manual', orgId: 3 });
  expect(ticketInsert()[1][0]).toBe('Escalated from AI support conversation #5. Reason: manual');
});
