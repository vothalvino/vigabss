'use strict';
// =============================================================================
// DAL-14 — deleting a status-driven row also switches it off
// =============================================================================
// BaseModel.delete only set deleted_at, so rows the runtime selects by a flag
// (webhooks and suspension rules by is_active, gateways and recurring profiles
// by status, alert rules, channels and suppressions by is_enabled) kept firing
// after they were deleted.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');

beforeEach(() => jest.clearAllMocks());

test.each([
  ['Webhook', 'is_active', 0],
  ['SuspensionRule', 'is_active', 0],
  ['PaymentGateway', 'status', 'inactive'],
  ['RecurringPaymentProfile', 'status', 'revoked'],
])('deleting a %s sets %s in the same UPDATE as deleted_at', async (model, column, value) => {
  const Model = require(`../src/models/${model}`);
  db.query.mockResolvedValue([{ affectedRows: 1 }]);

  await Model.delete(5, 42);

  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toMatch(new RegExp(`SET deleted_at = NOW\\(\\), \`${column}\` = \\? WHERE id = \\?`));
  expect(params).toEqual([value, 5, 42]);
});

test('a model without the option still only sets deleted_at', async () => {
  const Client = require('../src/models/Client');
  db.query.mockResolvedValue([{ affectedRows: 1 }]);
  await Client.delete(5, 42);
  expect(db.query.mock.calls[0][0]).toMatch(/SET deleted_at = NOW\(\) WHERE id = \?/);
});

test('alert rules, channels and suppressions are disabled when deleted', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'alerts.js'), 'utf8');
  for (const table of ['alert_rules', 'alert_notification_channels', 'alert_suppression_rules']) {
    expect(src).toContain(`UPDATE ${table} SET deleted_at = NOW(), is_enabled = 0 WHERE`);
  }
});
