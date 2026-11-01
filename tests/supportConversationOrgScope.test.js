// =============================================================================
// SUP-02 — the AI support engine records what it tells the customer it did
// =============================================================================
// _generateResponse called the billing and general modules without orgId, so
// every handler's SQL bound undefined (mysql2 rejects that) and their catch
// branches still replied "Registramos tu reporte…" / "Hemos registrado tu
// queja…". Cancellations and first-message disputes promised an agent and
// stored nothing, and the 'other' reply promised a handoff it never made.
//
// This drives startConversation and sendMessage into the real modules with a
// database double that rejects undefined binds, like mysql2's execute().
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/supportContextService', () => ({
  // The real context carries the customer but no organization id.
  enrichContext: jest.fn().mockResolvedValue({ customer: { id: 10, name: 'Ana' }, billing: null, connection: null, alerts: [] }),
}));
jest.mock('../src/services/diagnosticEngineService', () => ({
  generateSupportResponse: jest.fn().mockResolvedValue({ reply: 'ok', escalate: false, escalationReason: null }),
}));

const db = require('../src/config/database');
const service = require('../src/services/supportConversationService');

let failTicketInsert;
let conversation;
beforeEach(() => {
  jest.clearAllMocks();
  failTicketInsert = false;
  conversation = { id: 1, organization_id: 1, client_id: 10, status: 'open', ticket_id: null };
  db.query.mockImplementation(async (sql, params = []) => {
    if (params.some((p) => p === undefined)) throw new TypeError('Bind parameters must not contain undefined.');
    if (/INSERT INTO support_conversations/.test(sql)) return [{ insertId: 1 }];
    if (/UPDATE support_conversations SET status = 'escalated'/.test(sql) || /SET status = 'escalated'/.test(sql)) {
      const claimed = conversation.status !== 'escalated';
      conversation.status = 'escalated';
      return [{ affectedRows: claimed ? 1 : 0 }];
    }
    if (/INSERT INTO tickets/.test(sql)) {
      if (failTicketInsert && !/ai_escalated/.test(sql)) throw new Error('ER_LOCK_WAIT_TIMEOUT');
      return [{ insertId: 77 }];
    }
    if (/FROM support_conversations/.test(sql)) return [[conversation]];
    if (/FROM support_messages/.test(sql)) return [/COUNT/.test(sql) ? [{ cnt: 0 }] : []];
    return [{ insertId: 5, affectedRows: 1 }];
  });
});

const ticketInserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO tickets/.test(sql));
const assistantReplies = () => db.query.mock.calls
  .filter(([sql, p]) => /INSERT INTO support_messages/.test(sql) && p.includes('assistant'))
  .map(([, p]) => p.find((v) => typeof v === 'string' && v.startsWith('Soy tu asistente')));

test('a damage report opens a ticket in the organization', async () => {
  await service.startConversation({ orgId: 1, clientId: 10, message: 'el equipo está roto' });
  const [sql, params] = ticketInserts()[0];
  expect(sql).toMatch(/INSERT INTO tickets/);
  expect(params.slice(0, 2)).toEqual([1, 10]);
  expect(assistantReplies()[0]).toMatch(/Hemos creado un ticket/);
});

test('when the ticket cannot be written, the reply says so and a person takes over', async () => {
  failTicketInsert = true;
  await service.startConversation({ orgId: 1, clientId: 10, message: 'quiero poner una queja del técnico' });
  expect(assistantReplies()[0]).toMatch(/No pude registrar tu queja/);
  expect(assistantReplies()[0]).not.toMatch(/Hemos registrado/);
  expect(conversation.status).toBe('escalated');
  expect(ticketInserts().some(([sql]) => /ai_escalated/.test(sql))).toBe(true);
});

test.each([
  ['a cancellation', 'quiero cancelar mi plan'],
  ['a first-message billing dispute', 'me hicieron un cobro incorrecto'],
])('%s is escalated with a ticket, not just promised', async (_label, message) => {
  await service.startConversation({ orgId: 1, clientId: 10, message });
  expect(conversation.status).toBe('escalated');
  expect(ticketInserts().some(([sql]) => /ai_escalated/.test(sql))).toBe(true);
});

test('a follow-up cancellation is escalated too', async () => {
  await service.sendMessage({ conversationId: 1, orgId: 1, clientId: 10, content: 'quiero dar de baja el servicio, cancelar' });
  expect(conversation.status).toBe('escalated');
});

test('an unclassified message does not promise a handoff', async () => {
  await service.startConversation({ orgId: 1, clientId: 10, message: 'asdf qwer' });
  expect(assistantReplies()[0]).not.toMatch(/conectarte con el área correcta/);
  expect(conversation.status).toBe('open');
});

test('the modules refuse to run without an organization', async () => {
  const billing = require('../src/services/supportBillingModule');
  const general = require('../src/services/supportGeneralModule');
  await expect(billing.handle('billing', {}, 'saldo')).rejects.toThrow(/orgId is required/);
  await expect(general.handle('general', {}, 'horario')).rejects.toThrow(/orgId is required/);
});
