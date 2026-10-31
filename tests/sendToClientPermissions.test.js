// =============================================================================
// FE-13 — emailing an invoice or a receipt to the client is a mutation
// =============================================================================
// POST /invoices/:id/send-email required only invoices.view and
// /payments/:id/send-receipt only payments.view, so readonly (which holds
// every *.view slug) could send invoices and receipts to clients.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/emailTransport', () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const emailTransport = require('../src/services/emailTransport');
const app = require('../src/app');

const token = jwt.sign({ sub: 4, email: 'r@test.com', role: 'readonly', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
const post = (path) => request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send({});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue([[{ id: 9, organization_id: 1, client_id: 3, email: 'client@test.com', total: '100.00', status: 'issued' }]]);
  User.findById.mockResolvedValue({ id: 4, email: 'r@test.com', status: 'active', role: 'readonly', organization_id: 1 });
  User.getPermissions.mockResolvedValue(['invoices.view', 'payments.view', 'clients.view']);
});

test.each(['/invoices/9/send-email', '/payments/9/send-receipt'])('%s is refused to a view-only user', async (path) => {
  const res = await post(path);
  expect(res.status).toBe(403);
  expect(emailTransport.sendEmail).not.toHaveBeenCalled();
});
