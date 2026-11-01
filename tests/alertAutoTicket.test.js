// =============================================================================
// DB-10 — an alert rule's auto-ticket is a valid ticket row
// =============================================================================
// autoCreateTicket inserted (organization_id, subject, description, priority,
// category, status), but tickets.client_id is NOT NULL with no default, so
// strict-mode MySQL rejected every auto-ticket and the catch discarded the
// error. The ticket now belongs to the breached device's client.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  log.child = () => log;
  return log;
});

const db = require('../src/config/database');
const logger = require('../src/utils/logger');
const alertService = require('../src/services/alertService');

// Columns of `tickets` an INSERT must name: NOT NULL, no DEFAULT, not generated
// or auto-increment.
function requiredTicketColumns() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  const body = schema.match(/CREATE TABLE IF NOT EXISTS tickets \(([\s\S]*?)\n\) ENGINE/)[1];
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s/.test(line) && !/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|INDEX)\b/i.test(line))
    .filter((line) => /NOT NULL/i.test(line) && !/DEFAULT|AUTO_INCREMENT|GENERATED/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

const RULE = { id: 1, name: 'High CPU', severity: 'critical' };
const BREACH = { device_id: 5, metric: 'cpu_usage', operator: '>', threshold: 90, current_value: 97 };

beforeEach(() => jest.clearAllMocks());

test('the auto-ticket INSERT supplies every required tickets column', async () => {
  db.query
    .mockResolvedValueOnce([[]]) // no open ticket for this alert
    .mockResolvedValueOnce([[{ client_id: 30, contract_id: 31 }]]) // the device's client
    .mockResolvedValueOnce([{ insertId: 77 }]);
  await alertService.autoCreateTicket(1, RULE, BREACH);

  const [sql, params] = db.query.mock.calls.find(([q]) => /INSERT INTO tickets/.test(q));
  const columns = sql.match(/\(([^)]+)\)/)[1].split(',').map((c) => c.trim());
  const required = requiredTicketColumns();
  expect(required).toContain('client_id');
  expect(required.filter((c) => !columns.includes(c))).toEqual([]);
  expect(params).toEqual(expect.arrayContaining([1, 30, 31]));
  expect(sql).toMatch(/'alert'\)/);
  expect(logger.error).not.toHaveBeenCalled();
});

test('a device with no client gets no ticket, and that is logged', async () => {
  db.query
    .mockResolvedValueOnce([[]])
    .mockResolvedValueOnce([[{ client_id: null, contract_id: null }]]);
  await alertService.autoCreateTicket(1, RULE, BREACH);
  expect(db.query.mock.calls.some(([q]) => /INSERT INTO tickets/.test(q))).toBe(false);
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 5 }), expect.stringMatching(/no client/));
});

test('a failed insert is logged, not discarded', async () => {
  db.query
    .mockResolvedValueOnce([[]])
    .mockResolvedValueOnce([[{ client_id: 30, contract_id: null }]])
    .mockRejectedValueOnce(Object.assign(new Error("Field 'x' doesn't have a default value"), { code: 'ER_NO_DEFAULT_FOR_FIELD' }));
  await expect(alertService.autoCreateTicket(1, RULE, BREACH)).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ ruleId: 1 }), 'Alert auto-ticket failed');
});
