// The support chat answered with fixed rule-based sentences. With the AI
// assistant enabled for the channel, the organization's model words the
// reply — from the rule-based answer as its only source of facts — and every
// failure falls back to that rule-based text.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const mock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => mock) };
  return mock;
});
const mockPolicy = jest.fn();
jest.mock('../src/models/AiPolicy', () => ({ findByOrgId: (...a) => mockPolicy(...a) }));
const mockOverBudget = jest.fn();
jest.mock('../src/services/aiBudgetService', () => ({ overBudget: (...a) => mockOverBudget(...a) }));
const mockTerms = jest.fn();
jest.mock('../src/services/phraseLibraryService', () => ({ listForbiddenTerms: (...a) => mockTerms(...a) }));
const mockChat = jest.fn();
jest.mock('../src/services/llmProviderService', () => ({ chat: (...a) => mockChat(...a) }));

const db = require('../src/config/database');
const { writeReply, enabledFor, MAX_REPLY_CHARS } = require('../src/services/supportAiWriter');

const POLICY = {
  enabled: 1, active_provider_id: 7, tone: 'friendly', default_locale: 'es',
  enabled_channels: JSON.stringify({ sms: false, email: false, portal: true, whatsapp: true }),
};
const ARGS = {
  orgId: 3, conversationId: 5, channel: 'whatsapp',
  customerMessage: 'cuanto debo', ruleReply: 'Soy tu asistente virtual. Tu saldo pendiente es $232.00, vence el 30 nov.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPolicy.mockResolvedValue(POLICY);
  mockOverBudget.mockResolvedValue(false);
  mockTerms.mockResolvedValue({ data: [{ term: 'garantizado' }] });
  mockChat.mockResolvedValue({ text: 'Hola, tu saldo pendiente es de $232.00 y vence el 30 de noviembre.' });
  db.query.mockResolvedValue([[
    { role: 'customer', content: 'cuanto debo' },
    { role: 'assistant', content: 'Soy tu asistente virtual. ¿En qué puedo ayudarte?' },
    { role: 'customer', content: 'hola' },
  ]]);
});

test('the model words the reply from the rule-based answer', async () => {
  expect(await writeReply(ARGS)).toBe('Hola, tu saldo pendiente es de $232.00 y vence el 30 de noviembre.');
  const call = mockChat.mock.calls[0][0];
  expect(call).toMatchObject({ providerId: 7, orgId: 3 });
  const system = call.messages[0];
  expect(system.role).toBe('system');
  expect(system.content).toContain('Tu saldo pendiente es $232.00, vence el 30 nov.');
  expect(system.content).toMatch(/using only the verified information/);
  expect(system.content).toMatch(/Never state an amount, date/);
  expect(system.content).toContain('garantizado');
  expect(system.content).toMatch(/warm and friendly/);
});

test('the conversation is sent oldest first and ends with the customer', async () => {
  await writeReply(ARGS);
  const turns = mockChat.mock.calls[0][0].messages.slice(1);
  expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user']);
  expect(turns[turns.length - 1].content).toBe('cuanto debo');
});

test('the history is read through the conversation of that organization', async () => {
  await writeReply(ARGS);
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(/JOIN support_conversations sc ON sc\.id = sm\.conversation_id/);
  expect(sql).toMatch(/sc\.organization_id = \?/);
  expect(params.slice(0, 2)).toEqual([5, 3]);
});

test.each([
  ['the assistant is switched off', { ...POLICY, enabled: 0 }],
  ['the channel is switched off', { ...POLICY, enabled_channels: JSON.stringify({ portal: true, whatsapp: false }) }],
  ['no provider is active', { ...POLICY, active_provider_id: null }],
  ['the channel list is unreadable', { ...POLICY, enabled_channels: '{not json' }],
])('keeps the rule-based reply when %s, without a provider call', async (_label, policy) => {
  mockPolicy.mockResolvedValue(policy);
  expect(await writeReply(ARGS)).toBeNull();
  expect(mockChat).not.toHaveBeenCalled();
});

test('keeps the rule-based reply when the organization is over its AI budget', async () => {
  mockOverBudget.mockResolvedValue(true);
  expect(await writeReply(ARGS)).toBeNull();
  expect(mockChat).not.toHaveBeenCalled();
});

test.each([
  ['the provider fails', () => mockChat.mockRejectedValue(new Error('LLM_REFUSED'))],
  ['the reply is empty', () => mockChat.mockResolvedValue({ text: '   ' })],
  ['the reply uses a forbidden term', () => mockChat.mockResolvedValue({ text: 'Servicio GARANTIZADO al 100%.' })],
  ['the history cannot be read', () => db.query.mockRejectedValue(new Error('ER_LOCK_WAIT_TIMEOUT'))],
])('keeps the rule-based reply when %s', async (_label, arrange) => {
  arrange();
  expect(await writeReply(ARGS)).toBeNull();
});

test('a very long reply is cut for a phone screen', async () => {
  mockChat.mockResolvedValue({ text: 'a'.repeat(3000) });
  const reply = await writeReply(ARGS);
  expect(reply.length).toBe(MAX_REPLY_CHARS);
  expect(reply.endsWith('…')).toBe(true);
});

test('the staff Conversations tab ("web") follows the portal switch', () => {
  expect(enabledFor(POLICY, 'web')).toBe(true);
  expect(enabledFor({ ...POLICY, enabled_channels: { portal: false, whatsapp: true } }, 'web')).toBe(false);
  expect(enabledFor(POLICY, 'constructor')).toBe(false);
  expect(enabledFor(null, 'web')).toBe(false);
});

describe('with "mask personal data" on', () => {
  const MASKED = { ...POLICY, redact_pii_before_llm: 1 };
  const PRIVATE = ['ana@example.com', '+52 55 1234 5678', '10.20.30.40', 'AA:BB:CC:DD:EE:FF'];

  beforeEach(() => {
    mockPolicy.mockResolvedValue(MASKED);
    db.query.mockResolvedValue([[
      { role: 'customer', content: 'mi correo es ana@example.com y mi numero +52 55 1234 5678' },
    ]]);
  });

  const args = {
    ...ARGS,
    customerMessage: 'mi correo es ana@example.com y mi numero +52 55 1234 5678',
    ruleReply: 'Tu equipo AA:BB:CC:DD:EE:FF tiene la IP 10.20.30.40. Contacto: ana@example.com.',
  };

  test('nothing private is sent to the provider, in the facts or the conversation', async () => {
    mockChat.mockResolvedValue({ text: 'Listo.' });
    await writeReply(args);
    const sent = JSON.stringify(mockChat.mock.calls[0][0].messages);
    for (const value of PRIVATE) expect(sent).not.toContain(value);
    expect(sent).toMatch(/\[EMAIL_\d+\]/);
    expect(sent).toMatch(/\[MAC_\d+\]/);
    expect(sent).toMatch(/\[IP_\d+\]/);
    expect(mockChat.mock.calls[0][0].messages[0].content).toMatch(/Placeholders such as \[PHONE_1\]/);
  });

  test('the same value gets the same placeholder everywhere, and the reply gets the real value back', async () => {
    mockChat.mockImplementation(async ({ messages }) => {
      const token = /\[EMAIL_\d+\]/.exec(messages[0].content)[0];
      // The address appears in the facts and in the customer's message.
      expect(messages[messages.length - 1].content).toContain(token);
      return { text: `Te escribimos a ${token}.` };
    });
    expect(await writeReply(args)).toBe('Te escribimos a ana@example.com.');
  });

  test('a placeholder the model made up is not sent to the customer', async () => {
    mockChat.mockResolvedValue({ text: 'Llama al [PHONE_99].' });
    expect(await writeReply(args)).toBeNull();
  });
});

test('with masking off, the text is sent as written', async () => {
  await writeReply({ ...ARGS, ruleReply: 'Contacto: ana@example.com.' });
  expect(mockChat.mock.calls[0][0].messages[0].content).toContain('ana@example.com');
  expect(mockChat.mock.calls[0][0].messages[0].content).not.toMatch(/Placeholders such as/);
});

test('without a stored conversation the customer\'s message is the only turn', async () => {
  expect(await writeReply({ ...ARGS, conversationId: null })).toMatch(/\$232\.00/);
  expect(db.query).not.toHaveBeenCalled();
  expect(mockChat.mock.calls[0][0].messages.slice(1)).toEqual([{ role: 'user', content: 'cuanto debo' }]);
});
