// =============================================================================
// ASY-10 — the AI reply pipeline keeps PII and staff notes out of the LLM
// =============================================================================
// Classification sent the raw inbound text to the LLM before redaction ran;
// ticket history went into the prompt unredacted, staff-only notes included,
// and under auto_send the reply is posted to the customer unreviewed. The
// staff draft endpoints did not force draft mode, the inbound and context
// redactions both numbered their tokens from 1 (so rehydration restored the
// wrong value), and AI triage ran on staff comments instead of customer ones.
// Mock layout mirrors tests/aiReplyService.test.js.
// =============================================================================

// ---------------------------------------------------------------------------
// Model mocks
// ---------------------------------------------------------------------------
const mockFindByOrgId     = jest.fn();
const mockPolicyUpsert    = jest.fn();
const mockReplyLogCreate  = jest.fn();
const mockReplyLogUpdate  = jest.fn();
const mockTicketFindById  = jest.fn();
const mockTicketGetComments = jest.fn();
const mockTicketAddComment  = jest.fn();
const mockTicketCommentCreate = jest.fn();
const mockNotificationCreate  = jest.fn();

jest.mock('../src/models/AiPolicy', () => ({
  findByOrgId: mockFindByOrgId,
  upsert:      mockPolicyUpsert,
}));
jest.mock('../src/models/AiReplyLog', () => ({
  create: mockReplyLogCreate,
  update: mockReplyLogUpdate,
}));
jest.mock('../src/models/Ticket', () => ({
  findById:    mockTicketFindById,
  getComments: mockTicketGetComments,
  addComment:  mockTicketAddComment,
}));
jest.mock('../src/models/TicketComment', () => ({
  create: mockTicketCommentCreate,
}));
jest.mock('../src/models/Notification', () => ({
  create: mockNotificationCreate,
}));

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------
const mockTopologySummarize = jest.fn();
const mockHealthSnapshot    = jest.fn();
const mockGetPhrasesByCategory = jest.fn();
const mockGetTermsByLocale     = jest.fn();
const mockValidateDraft        = jest.fn();
const mockLlmChat              = jest.fn();
const mockPhraseSearch         = jest.fn().mockResolvedValue([]);

jest.mock('../src/services/topologyContextService', () => ({
  summarize: mockTopologySummarize,
}));
jest.mock('../src/services/serviceHealthService', () => ({
  getSnapshot: mockHealthSnapshot,
}));
jest.mock('../src/services/phraseLibraryService', () => ({
  getPhrasesByCategory: mockGetPhrasesByCategory,
  getTermsByLocale:     mockGetTermsByLocale,
  validateDraft:        mockValidateDraft,
  search:               mockPhraseSearch,
}));
jest.mock('../src/services/llmProviderService', () => ({
  chat: mockLlmChat,
}));

// generate() now proves the ticket and contract belong to the calling org before
// it does anything else (Step 0). That probe reads the DB directly, so this file
// needs a database mock it never previously required. Default: the ids DO belong
// to the org, so every pre-existing case behaves as it did.
const mockDbQuery = jest.fn();
jest.mock('../src/config/database', () => ({
  query:   (...args) => mockDbQuery(...args),
  execute: (...args) => mockDbQuery(...args),
}));

// ---------------------------------------------------------------------------
// Load service AFTER mocks are in place
// ---------------------------------------------------------------------------
const svc = require('../src/services/aiReplyService');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const DEFAULT_POLICY = {
  enabled:              1,
  enabled_channels:     { portal: true, email: false, whatsapp: false, sms: false },
  mode:                 'draft_only',
  auto_send_confidence: '0.85',
  default_locale:       'es-MX',
  tone:                 'formal',
  redact_pii_before_llm: 1,
  active_provider_id:   42,
};

const DEFAULT_CLASSIFY_RESPONSE = {
  text: '{"category":"connectivity","priority":"medium","language":"es-MX","confidence":0.92}',
  json: { category: 'connectivity', priority: 'medium', language: 'es-MX', confidence: 0.92 },
  usage: { prompt_tokens: 20, completion_tokens: 10 },
  cost_usd: 0.00001,
};

const DEFAULT_REPLY_RESPONSE = {
  text: 'Estimado cliente, hemos revisado su caso y todo está funcionando correctamente.',
  json: null,
  usage: { prompt_tokens: 150, completion_tokens: 50 },
  cost_usd: 0.0001,
};

const DEFAULT_LOG_ENTRY = { id: 101 };

const DEFAULT_TICKET = { id: 1, organization_id: 1, assigned_to: 7, contract_id: 10 };

function setupDefaults() {
  // Ownership probes pass, and _persistTriage's INSERT is a no-op.
  mockDbQuery.mockResolvedValue([[{ id: 1 }]]);
  mockFindByOrgId.mockResolvedValue({ ...DEFAULT_POLICY });
  mockTopologySummarize.mockResolvedValue({ cpe: null, accessDevice: null, backhauls: [], coreDevice: null, activeOutages: [] });
  mockHealthSnapshot.mockResolvedValue({ contractId: 1, radiusSession: null });
  mockGetPhrasesByCategory.mockResolvedValue({});
  mockGetTermsByLocale.mockResolvedValue([]);
  mockValidateDraft.mockResolvedValue({ valid: true, missingRequired: [], hitForbidden: [] });
  mockLlmChat
    .mockResolvedValueOnce(DEFAULT_CLASSIFY_RESPONSE) // classify
    .mockResolvedValueOnce(DEFAULT_REPLY_RESPONSE);    // generate
  mockReplyLogCreate.mockResolvedValue(DEFAULT_LOG_ENTRY);
  mockReplyLogUpdate.mockResolvedValue({ id: 101, action: 'auto_sent' });
  mockTicketFindById.mockResolvedValue(DEFAULT_TICKET);
  mockTicketGetComments.mockResolvedValue([]);
  mockTicketAddComment.mockResolvedValue({ id: 200 });
  mockTicketCommentCreate.mockResolvedValue({ id: 201 });
  mockNotificationCreate.mockResolvedValue({ id: 300 });
}


const chatPrompts = () => mockLlmChat.mock.calls.map(([args]) => JSON.stringify(args.messages));
const ARGS = { orgId: 1, ticketId: 1, channel: 'portal' };

beforeEach(() => {
  jest.clearAllMocks();
  mockLlmChat.mockReset();
  setupDefaults();
});

test('classification receives the redacted text, not the raw PII', async () => {
  await svc.generate({ ...ARGS, inboundText: 'Soy ana.lopez@example.com, mi tel 55 1234 5678 y no tengo internet' });
  const [classifyPrompt] = chatPrompts();
  expect(classifyPrompt).not.toMatch(/ana\.lopez@example\.com/);
  expect(classifyPrompt).not.toMatch(/55 1234 5678/);
  expect(chatPrompts().join(' ')).not.toMatch(/ana\.lopez@example\.com/);
});

test('ticket history is redacted, and staff notes stay out of an auto_send prompt', async () => {
  mockFindByOrgId.mockResolvedValue({ ...DEFAULT_POLICY, mode: 'auto_send' });
  mockTicketGetComments.mockResolvedValue([
    { body: 'Escribí antes desde pedro@example.com', is_internal: 0, created_at: new Date('2026-10-01T10:00:00Z') },
    { body: 'NOTA INTERNA: cliente moroso, no ofrecer descuento', is_internal: 1, created_at: new Date('2026-10-01T11:00:00Z') },
  ]);
  await svc.generate({ ...ARGS, inboundText: 'Sigo sin servicio' });
  const replyPrompt = chatPrompts()[1];
  expect(replyPrompt).not.toMatch(/pedro@example\.com/);
  expect(replyPrompt).not.toMatch(/NOTA INTERNA/);
});

test('staff notes still inform a draft that staff reviews', async () => {
  mockTicketGetComments.mockResolvedValue([
    { body: 'NOTA INTERNA: router reemplazado ayer', is_internal: 1, created_at: new Date('2026-10-01T11:00:00Z') },
  ]);
  await svc.generate({ ...ARGS, inboundText: 'Sigo sin servicio' });
  expect(chatPrompts()[1]).toMatch(/NOTA INTERNA/);
});

test('forceDraft never posts a public comment, even under auto_send', async () => {
  mockFindByOrgId.mockResolvedValue({ ...DEFAULT_POLICY, mode: 'auto_send', auto_send_confidence: '0.1' });
  const result = await svc.generate({ ...ARGS, inboundText: 'Sigo sin servicio', forceDraft: true });
  expect(result.action).toBe('proposed');
  expect(mockTicketCommentCreate).not.toHaveBeenCalled();
  expect(mockTicketAddComment).toHaveBeenCalledWith(expect.objectContaining({ is_internal: true }));
});

test('redactions in different texts get distinct tokens and rehydrate correctly', () => {
  const mapping = new Map();
  const a = svc._redactPii('mail ana@example.com', mapping).redacted;
  const b = svc._redactPii('mail luis@example.com', mapping).redacted;
  expect(a).not.toBe(b.replace('luis', 'ana'));
  expect(svc._rehydratePii(`${a} / ${b}`, mapping)).toBe('mail ana@example.com / mail luis@example.com');
});

test('with no inbound text, the latest customer-visible message is answered', async () => {
  mockDbQuery.mockImplementation(async (sql) => (/FROM ticket_comments/.test(sql)
    ? [[{ body: 'Hola, la luz del módem parpadea en rojo' }]]
    : [[{ id: 1 }]]));
  await svc.generate({ ...ARGS, inboundText: '' });
  expect(chatPrompts()[0]).toMatch(/parpadea en rojo/);
});

describe('triage runs on customer comments, not staff ones', () => {
  test('the staff comment route does not enqueue triage; the portal one does', () => {
    const fs = require('fs');
    const path = require('path');
    const staff = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'tickets.js'), 'utf8');
    const commentRoute = staff.slice(staff.indexOf("router.post('/:id/comments'"), staff.indexOf("router.put('/:id/comments/:commentId'"));
    expect(commentRoute).not.toMatch(/ai-triage/);
    const portal = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'portal.js'), 'utf8');
    const portalRoute = portal.slice(portal.indexOf("router.post('/tickets/:id/comments'"), portal.indexOf('// DATA PACKS'));
    expect(portalRoute).toMatch(/add\('ai-triage'/);
  });
});
