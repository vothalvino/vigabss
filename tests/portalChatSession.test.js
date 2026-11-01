// =============================================================================
// ASY-09 / TNB-29 — the portal AI chat keeps one ticket and never leaks drafts
// =============================================================================
// Every chat message INSERTed a new open ticket holding the transcript; with AI
// off (the default) each one stayed open. A draft_only draft — meant for staff
// review — was returned to the subscriber, the ticket was then closed even
// when generation failed and the reply promised a follow-up, and the
// 'escalate' branch could never run.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/aiReplyService', () => ({ generate: jest.fn() }));

const request = require('supertest');
const db = require('../src/config/database');
const aiReplyService = require('../src/services/aiReplyService');
const { signPortalAccessToken } = require('../src/utils/accessTokens');
const app = require('../src/app');

const token = signPortalAccessToken({ clientId: 5, organizationId: 1, tokenVersion: 0 }, 900);
const post = (message) => request(app).post('/api/v1/portal/chat/tok-123/message')
  .set('Authorization', `Bearer ${token}`).send({ message });

let session;
let nextTicketId;
beforeEach(() => {
  jest.clearAllMocks();
  session = { id: 3, messages: [], status: 'active', turn_count: 0, ticket_id: null };
  nextTicketId = 900;
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM clients WHERE id = \?/.test(sql)) {
      return [[{ id: 5, organization_id: 1, name: 'Ana', email: 'a@x.mx', status: 'active', portal_token_version: 0 }]];
    }
    if (/FROM portal_chat_sessions/.test(sql)) return [[{ ...session, messages: JSON.stringify(session.messages) }]];
    if (/UPDATE portal_chat_sessions/.test(sql)) {
      session = { ...session, messages: JSON.parse(params[0]), turn_count: params[1], status: params[2], ticket_id: params[3] };
      return [{ affectedRows: 1 }];
    }
    if (/SELECT id FROM tickets WHERE id = \?/.test(sql)) return [[{ id: params[0] }]];
    if (/INSERT INTO tickets/.test(sql)) return [{ insertId: nextTicketId++ }];
    return [{ affectedRows: 1, insertId: 1 }];
  });
});

const sqlCalls = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

test('with AI off, the first message opens one ticket and hands the chat to staff', async () => {
  aiReplyService.generate.mockResolvedValue({ skipped: true, reason: 'policy_disabled' });
  const res = await post('No tengo internet');
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
  expect(res.body.data.reply).toMatch(/support team will reply/);
  expect(sqlCalls(/INSERT INTO tickets/)).toHaveLength(1);
  expect(sqlCalls(/SET status = 'closed'/)).toHaveLength(0);
});

test('a draft kept for staff review is not shown to the subscriber', async () => {
  aiReplyService.generate.mockResolvedValue({ skipped: false, action: 'proposed', draftText: 'INTERNAL DRAFT: offer 50% off' });
  const res = await post('Mi factura está mal');
  expect(res.body.data.reply).not.toMatch(/INTERNAL DRAFT/);
  expect(res.body.data.session_status).toBe('escalated');
  expect(sqlCalls(/SET status = 'closed'/)).toHaveLength(0);
});

test.each([
  ['a failed generation', () => aiReplyService.generate.mockResolvedValue({ skipped: false, action: 'failed', draftText: null })],
  ['a thrown error', () => aiReplyService.generate.mockRejectedValue(new Error('LLM down'))],
])('%s keeps the ticket open and escalates', async (_label, arrange) => {
  arrange();
  const res = await post('Ayuda');
  expect(res.body.data).toMatchObject({ session_status: 'escalated', ticket_id: 900 });
  expect(sqlCalls(/SET status = 'closed'/)).toHaveLength(0);
});

test('an auto-sent reply is shown, and later messages reuse the same ticket', async () => {
  aiReplyService.generate.mockResolvedValue({ skipped: false, action: 'auto_sent', draftText: 'Reinicie su módem, por favor.' });
  const first = await post('No tengo internet');
  expect(first.body.data).toMatchObject({ reply: 'Reinicie su módem, por favor.', session_status: 'active', ticket_id: 900 });
  const second = await post('Ya lo reinicié');
  expect(second.body.data.ticket_id).toBe(900);

  expect(sqlCalls(/INSERT INTO tickets/)).toHaveLength(1);
  const comments = sqlCalls(/INSERT INTO ticket_comments/);
  expect(comments).toHaveLength(1);
  expect(comments[0][1]).toEqual([900, 'Ya lo reinicié']);
  expect(aiReplyService.generate).toHaveBeenLastCalledWith(expect.objectContaining({ ticketId: 900, inboundText: 'Ya lo reinicié' }));
  expect(sqlCalls(/SET status = 'waiting'/).length).toBeGreaterThan(0);
});
