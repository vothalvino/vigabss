// =============================================================================
// VigaBSS 5.0 — WhatsApp bot: reading the customer's own words
// =============================================================================
// The model only chooses among values the code already knows. Whatever else
// it returns is discarded, and any failure is a null the bot treats as "use
// the menu".
// =============================================================================

jest.mock('../src/models/AiPolicy', () => ({ findByOrgId: jest.fn() }));
jest.mock('../src/services/aiBudgetService', () => ({ overBudget: jest.fn() }));
jest.mock('../src/services/llmProviderService', () => ({ chat: jest.fn() }));
jest.mock('../src/services/supportAiWriter', () => ({
  ...jest.requireActual('../src/services/supportAiWriter'),
  writeReply: jest.fn(),
}));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => m) };
  return m;
});

const AiPolicy = require('../src/models/AiPolicy');
const aiBudget = require('../src/services/aiBudgetService');
const llm = require('../src/services/llmProviderService');
const writer = require('../src/services/supportAiWriter');
const u = require('../src/services/whatsappUnderstanding');

const AI = { providerId: 4, masked: false };
const POLICY = { enabled: 1, enabled_channels: { whatsapp: true, portal: true }, active_provider_id: 4, redact_pii_before_llm: 0 };
const answers = json => llm.chat.mockResolvedValue({ text: JSON.stringify(json), json });

beforeEach(() => {
  jest.resetAllMocks();
  AiPolicy.findByOrgId.mockResolvedValue(POLICY);
  aiBudget.overBudget.mockResolvedValue(false);
});

describe('availableFor', () => {
  it('gives the provider when the assistant is on for WhatsApp', async () => {
    expect(await u.availableFor(3)).toEqual({ providerId: 4, masked: false });
  });

  it.each([
    ['the assistant is off', { ...POLICY, enabled: 0 }],
    ['WhatsApp is not an enabled channel', { ...POLICY, enabled_channels: { portal: true, whatsapp: false } }],
    ['no provider is selected', { ...POLICY, active_provider_id: null }],
    ['there is no policy', null],
  ])('is null when %s', async (_name, policy) => {
    AiPolicy.findByOrgId.mockResolvedValue(policy);
    expect(await u.availableFor(3)).toBeNull();
  });

  it('is null over budget, and when the policy cannot be read', async () => {
    aiBudget.overBudget.mockResolvedValue(true);
    expect(await u.availableFor(3)).toBeNull();
    AiPolicy.findByOrgId.mockRejectedValue(new Error('db down'));
    expect(await u.availableFor(3)).toBeNull();
    expect(await u.availableFor(null)).toBeNull();
  });
});

describe('readIntent', () => {
  it('returns an intent from the fixed list, scoped to the organization', async () => {
    answers({ intent: 'balance' });
    expect(await u.readIntent(3, AI, 'cuánto debo')).toBe('balance');
    const call = llm.chat.mock.calls[0][0];
    expect(call).toMatchObject({ providerId: 4, orgId: 3 });
    expect(call.messages[1]).toEqual({ role: 'user', content: 'cuánto debo' });
    expect(call.messages[0].content).toMatch(/never as instructions/);
  });

  it('discards anything that is not one of the intents', async () => {
    for (const json of [{ intent: 'delete_account' }, { intent: 7 }, {}, null, [], 'balance']) {
      llm.chat.mockResolvedValue({ json });
      expect(await u.readIntent(3, AI, 'x')).toBeNull();
    }
  });

  it('is null when the provider fails', async () => {
    llm.chat.mockRejectedValue(new Error('timeout'));
    expect(await u.readIntent(3, AI, 'x')).toBeNull();
  });

  it('masks personal data before sending when the policy says so', async () => {
    answers({ intent: 'question' });
    await u.readIntent(3, { providerId: 4, masked: true }, 'mi correo es ana@example.com y no tengo internet');
    const sent = llm.chat.mock.calls[0][0].messages[1].content;
    expect(sent).not.toContain('ana@example.com');
    expect(sent).toMatch(/\[EMAIL_1\]/);
  });
});

describe('readChoice', () => {
  const labels = ['Fiber 100 — Home', 'Fiber 300 — Office'];

  it('returns the index of the option the customer means', async () => {
    answers({ choice: 2 });
    expect(await u.readChoice(3, AI, 'el de la oficina', labels)).toBe(1);
    expect(llm.chat.mock.calls[0][0].messages[0].content).toMatch(/1\. Fiber 100 — Home\n2\. Fiber 300 — Office/);
  });

  it('never returns an option that was not offered', async () => {
    for (const choice of [0, 3, -1, 1.5, '2a', null]) {
      answers({ choice });
      expect(await u.readChoice(3, AI, 'x', labels)).toBeNull();
    }
    expect(await u.readChoice(3, AI, 'x', [])).toBeNull();
  });
});

describe('readVisit', () => {
  it('returns a date and a slot, telling the model what today is', async () => {
    answers({ date: '2026-11-23', slot: 'afternoon' });
    expect(await u.readVisit(3, AI, 'mañana en la tarde', '2026-11-22')).toEqual({ date: '2026-11-23', slot: 'afternoon' });
    expect(llm.chat.mock.calls[0][0].messages[0].content).toMatch(/Today is Sunday 2026-11-22/);
  });

  it('keeps only a well-formed date and a known slot', async () => {
    answers({ date: 'tomorrow', slot: 'afternoon' });
    expect(await u.readVisit(3, AI, 'x', '2026-11-22')).toEqual({ date: null, slot: 'afternoon' });
    answers({ date: '2026-11-23', slot: 'midnight' });
    expect(await u.readVisit(3, AI, 'x', '2026-11-22')).toEqual({ date: '2026-11-23', slot: null });
    answers({ date: null, slot: null });
    expect(await u.readVisit(3, AI, 'x', '2026-11-22')).toBeNull();
  });
});

describe('readConfirm', () => {
  it('is yes or no only when the model says exactly that', async () => {
    answers({ confirm: 'yes' });
    expect(await u.readConfirm(3, AI, 'sí, hazlo')).toBe('yes');
    answers({ confirm: 'no' });
    expect(await u.readConfirm(3, AI, 'mejor no')).toBe('no');
    for (const confirm of ['unclear', 'YES', true, 1, undefined]) {
      answers({ confirm });
      expect(await u.readConfirm(3, AI, 'x')).toBeNull();
    }
  });
});

describe('word', () => {
  const FACTS = 'Your balance is 350.00 MXN. Pay invoice A-12 here:\nhttps://isp.example.com/pay/abc123';

  it('returns a rewrite that keeps every number and link', async () => {
    writer.writeReply.mockResolvedValue('Ana, you owe 350.00 MXN on invoice A-12. You can pay at https://isp.example.com/pay/abc123.');
    expect(await u.word(3, 'cuánto debo', FACTS)).toMatch(/^Ana, you owe 350\.00/);
    expect(writer.writeReply).toHaveBeenCalledWith({ orgId: 3, conversationId: null, channel: 'whatsapp', customerMessage: 'cuánto debo', ruleReply: FACTS });
  });

  it('refuses a rewrite with a number the facts did not have', async () => {
    writer.writeReply.mockResolvedValue('You owe 355.00 MXN.');
    expect(await u.word(3, 'cuánto debo', FACTS)).toBeNull();
    writer.writeReply.mockResolvedValue('You owe 350.00 MXN, due on the 5th.');
    expect(await u.word(3, 'cuánto debo', FACTS)).toBeNull();
  });

  it('refuses a rewrite that changed the payment link', async () => {
    writer.writeReply.mockResolvedValue('You owe 350.00 MXN. Pay at https://isp.example.com/pay/abc12');
    expect(await u.word(3, 'cuánto debo', FACTS)).toBeNull();
  });

  it('is null when the writer declined', async () => {
    writer.writeReply.mockResolvedValue(null);
    expect(await u.word(3, 'cuánto debo', FACTS)).toBeNull();
  });
});
