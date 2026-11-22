// =============================================================================
// VigaBSS 5.0 — Portal chat answered by the support conversation engine
// =============================================================================
// With the assistant set to answer on the portal by itself, the portal chat
// goes to the support engine (account and connection checks, a short reply)
// and no ticket is opened unless the chat is handed to staff. Any other
// configuration keeps the ticket-per-session behaviour.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/aiReplyService', () => ({ generate: jest.fn() }));
jest.mock('../src/services/supportConversationService', () => ({
  startConversation: jest.fn(), sendMessage: jest.fn(),
}));
jest.mock('../src/models/AiPolicy', () => ({ findByOrgId: jest.fn() }));

const request = require('supertest');
const db = require('../src/config/database');
const aiReplyService = require('../src/services/aiReplyService');
const support = require('../src/services/supportConversationService');
const AiPolicy = require('../src/models/AiPolicy');
const portalChatEngine = require('../src/services/portalChatEngine');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const token = signPortalAccessToken({ clientId: 5, organizationId: 1, tokenVersion: 0 }, 900);
const post = (message) => request(app).post('/api/v1/portal/chat/tok-123/message')
  .set('Authorization', `Bearer ${token}`).send({ message });

const POLICY = { enabled: 1, enabled_channels: { portal: true, whatsapp: false }, mode: 'auto_send', active_provider_id: 4 };
const answered = (text, extra = {}) => ({
  conversation: { id: 77, status: 'open', ticket_id: null, ...extra },
  messages: [{ role: 'customer', content: 'x' }, { role: 'assistant', content: text }],
});

let session;
let nextTicketId;
beforeEach(() => {
  jest.clearAllMocks();
  session = { id: 3, messages: [], status: 'active', turn_count: 0, ticket_id: null, support_conversation_id: null };
  nextTicketId = 900;
  AiPolicy.findByOrgId.mockResolvedValue(POLICY);
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM clients WHERE id = \?/.test(sql)) {
      return [[{ id: 5, organization_id: 1, name: 'Ana', email: 'a@x.mx', status: 'active', portal_token_version: 0 }]];
    }
    if (/SUM\(turn_count\)/.test(sql)) return [[{ turns: 0 }]];
    if (/FROM portal_chat_sessions/.test(sql)) return [[{ ...session, messages: JSON.stringify(session.messages) }]];
    if (/UPDATE portal_chat_sessions/.test(sql)) {
      session = {
        ...session, messages: JSON.parse(params[0]), turn_count: params[1], status: params[2],
        ticket_id: params[3], support_conversation_id: params[4],
      };
      return [{ affectedRows: 1 }];
    }
    if (/SELECT id FROM tickets WHERE id = \?/.test(sql)) return [[{ id: params[0] }]];
    if (/INSERT INTO tickets/.test(sql)) return [{ insertId: nextTicketId++ }];
    return [{ affectedRows: 1, insertId: 1 }];
  });
});
const sqlCalls = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

describe('with the assistant answering on the portal by itself', () => {
  test('the engine answers, the chat stays open and no ticket is created', async () => {
    support.startConversation.mockResolvedValue(answered('Tu conexión se ve bien. Reinicia el módem y dime si mejora.'));
    const res = await post('mi internet está lento');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      reply: 'Tu conexión se ve bien. Reinicia el módem y dime si mejora.',
      session_status: 'active', turn_count: 1, ticket_id: null,
    });
    expect(support.startConversation).toHaveBeenCalledWith({ orgId: 1, clientId: 5, channel: 'portal', message: 'mi internet está lento' });
    expect(sqlCalls(/INSERT INTO tickets/)).toHaveLength(0);
    expect(aiReplyService.generate).not.toHaveBeenCalled();
    expect(session.support_conversation_id).toBe(77);
  });

  test('a follow-up continues the same conversation', async () => {
    session.support_conversation_id = 77;
    session.turn_count = 1;
    support.sendMessage.mockResolvedValue(answered('Gracias. Veo tu módem en línea desde hace 2 minutos.'));
    const res = await post('ya lo reinicié');
    expect(support.sendMessage).toHaveBeenCalledWith({ conversationId: 77, orgId: 1, content: 'ya lo reinicié', clientId: 5 });
    expect(support.startConversation).not.toHaveBeenCalled();
    expect(res.body.data.session_status).toBe('active');
  });

  test('a session keeps its engine even if the policy is switched off mid-chat', async () => {
    session.support_conversation_id = 77;
    AiPolicy.findByOrgId.mockResolvedValue({ ...POLICY, enabled: 0 });
    support.sendMessage.mockResolvedValue(answered('ok'));
    await post('hola');
    expect(support.sendMessage).toHaveBeenCalled();
  });

  test('a hand-off shows the engine\'s ticket and escalates the session', async () => {
    support.startConversation.mockResolvedValue(answered('Te paso con un agente; tu ticket es el #412.', { status: 'escalated', ticket_id: 412 }));
    const res = await post('quiero hablar con una persona');
    expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 412, reply: 'Te paso con un agente; tu ticket es el #412.' });
    expect(sqlCalls(/INSERT INTO tickets/)).toHaveLength(0);
    expect(aiReplyService.generate).not.toHaveBeenCalled();
  });

  test('a hand-off whose ticket could not be opened still leaves the customer with one', async () => {
    support.startConversation.mockResolvedValue(answered('Te paso con un agente.', { status: 'escalated', ticket_id: null }));
    const res = await post('quiero hablar con una persona');
    expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
    expect(sqlCalls(/INSERT INTO tickets/)).toHaveLength(1);
    expect(aiReplyService.generate).not.toHaveBeenCalled();
  });

  test('when the engine fails the chat goes to staff with a ticket, not to the ticket-reply writer', async () => {
    support.startConversation.mockRejectedValue(new Error('db down'));
    const res = await post('mi internet está lento');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
    expect(res.body.data.reply).toMatch(/support team will reply/);
    expect(aiReplyService.generate).not.toHaveBeenCalled();
  });

  test('past the turn cap nothing is asked of any model and the chat goes to staff', async () => {
    session.turn_count = 20;
    const res = await post('otra pregunta');
    expect(support.startConversation).not.toHaveBeenCalled();
    expect(aiReplyService.generate).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
  });

  test('a session that already has a ticket stays on the ticket path', async () => {
    session.ticket_id = 850;
    aiReplyService.generate.mockResolvedValue({ skipped: true, reason: 'x' });
    await post('hola');
    expect(support.startConversation).not.toHaveBeenCalled();
    expect(sqlCalls(/INSERT INTO ticket_comments/)).toHaveLength(1);
  });
});

describe('in any other configuration the chat keeps its ticket', () => {
  test.each([
    ['the assistant is off', { ...POLICY, enabled: 0 }],
    ['the portal channel is off', { ...POLICY, enabled_channels: { portal: false } }],
    ['replies are drafts for staff', { ...POLICY, mode: 'draft_only' }],
    ['replies are suggestions', { ...POLICY, mode: 'suggest' }],
    ['no provider is selected', { ...POLICY, active_provider_id: null }],
  ])('when %s', async (_name, policy) => {
    AiPolicy.findByOrgId.mockResolvedValue(policy);
    aiReplyService.generate.mockResolvedValue({ skipped: true, reason: 'policy' });
    const res = await post('mi internet está lento');
    expect(support.startConversation).not.toHaveBeenCalled();
    expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
    expect(aiReplyService.generate).toHaveBeenCalled();
  });

  test('enabledFor is false when the policy cannot be read', async () => {
    AiPolicy.findByOrgId.mockRejectedValue(new Error('db down'));
    expect(await portalChatEngine.enabledFor(1)).toBe(false);
    expect(await portalChatEngine.enabledFor(null)).toBe(false);
  });
});

test('migration 014 adds the column only when missing, and its rollback removes it', () => {
  const fs = require('fs');
  const path = require('path');
  const read = dir => fs.readFileSync(path.join(__dirname, '..', 'database', dir, '014_portal_chat_conversation.sql'), 'utf8');
  expect(read('migrations')).toMatch(/IF NOT EXISTS[\s\S]*COLUMN_NAME = 'support_conversation_id'[\s\S]*ADD COLUMN support_conversation_id BIGINT UNSIGNED NULL/);
  expect(read('rollbacks')).toMatch(/IF EXISTS[\s\S]*DROP COLUMN support_conversation_id/);
});
