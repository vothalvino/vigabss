// =============================================================================
// GQL-05 / FE-12 — ticket live updates reach the page, and no token is logged
// =============================================================================
// TICKET_COMMENT_ADDED was published only by staff comments, so the customer's
// portal replies and the AI's never refreshed an open ticket; the event had
// no organization, so the same ticket id in an isolated tenant would match.
// The subscription client also put the staff JWT in the URL, which the request
// log recorded (extensions was not a redacted parameter).
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn().mockResolvedValue(undefined), process: jest.fn() }));

const request = require('supertest');
const db = require('../src/config/database');
const pubsubModule = require('../src/services/pubsub');
const { maskUrl } = require('../src/middleware/requestLogger');
const { signPortalAccessToken } = require('../src/utils/accessTokens');

let published;
beforeEach(() => {
  jest.clearAllMocks();
  published = [];
  jest.spyOn(pubsubModule.pubsub, 'publish').mockImplementation((name, payload) => { published.push({ name, ...payload }); });
});

test('a portal comment refreshes the open ticket, scoped to its organization', async () => {
  db.query.mockImplementation(async (sql) => {
    if (/FROM clients WHERE id = \?/.test(sql)) return [[{ id: 5, organization_id: 3, name: 'Ana', status: 'active', portal_token_version: 0 }]];
    if (/SELECT id, contract_id FROM tickets/.test(sql)) return [[{ id: 40, contract_id: null }]];
    if (/INSERT INTO ticket_comments/.test(sql)) return [{ insertId: 8 }];
    if (/FROM ticket_comments WHERE id = \?/.test(sql)) return [[{ id: 8, ticket_id: 40, body: 'Sigo sin servicio' }]];
    return [[]];
  });
  const app = require('../src/app');
  const token = signPortalAccessToken({ clientId: 5, organizationId: 3, tokenVersion: 0 }, 900);
  const res = await request(app).post('/api/v1/portal/tickets/40/comments').set('Authorization', `Bearer ${token}`).send({ body: 'Sigo sin servicio' });
  expect(res.status).toBe(201);
  expect(published).toEqual([expect.objectContaining({ name: 'TICKET_COMMENT_ADDED', ticketId: '40', orgId: 3 })]);
});

test('every AI comment write publishes', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'aiReplyService.js'), 'utf8');
  expect(src).not.toMatch(/await (Ticket\.addComment|TicketComment\.create)\(/);
  expect(src.match(/_publishComment\(orgId, ticketId, (Ticket\.addComment|TicketComment\.create)\(/g).length).toBeGreaterThanOrEqual(5);
});

test('a token in a logged URL is redacted', () => {
  const url = '/api/v1/graphql?query=subscription&extensions=%7B%22authorization%22%3A%22Bearer%20eyJhbGciOi.abc.def%22%7D';
  const masked = maskUrl(url);
  expect(masked).not.toMatch(/eyJhbGciOi/);
  expect(masked).toMatch(/extensions=\[REDACTED\]/);
  expect(maskUrl('/x?note=Bearer%20abc.def.ghi')).not.toMatch(/abc\.def\.ghi/);
});
