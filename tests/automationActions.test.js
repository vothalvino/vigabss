// =============================================================================
// ASY-36 — automation rules do what they say, on the events they name
// =============================================================================
// No rule action had a handler (create_ticket, suspend_contract and
// send_notification recorded 'not implemented'), and rules ran only through
// the manual /execute route: nothing subscribed them to eventBus.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/suspensionService', () => ({ suspendContract: jest.fn() }));
jest.mock('../src/services/messageOutbox', () => ({ enqueue: jest.fn() }));
jest.mock('../src/services/businessEvents', () => ({ emitTicketCreated: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const db = require('../src/config/database');
const suspensionService = require('../src/services/suspensionService');
const messageOutbox = require('../src/services/messageOutbox');
const businessEvents = require('../src/services/businessEvents');
const eventBus = require('../src/services/eventBus');
const automationActions = require('../src/services/automationActions');
const automationService = require('../src/services/automationService');

const CLIENT = { id: 7, name: 'Ana', email: 'ana@example.com', phone: '+525512345678' };
const CONTRACT = { id: 70, client_id: 7, status: 'active' };
let rules;

function routeDb() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/SELECT DISTINCT trigger_event FROM automation_rules/.test(sql)) {
      return [[...new Set(rules.map(r => r.trigger_event))].map(trigger_event => ({ trigger_event }))];
    }
    if (/SELECT \* FROM automation_rules\s+WHERE organization_id = \? AND trigger_event = \?/.test(sql)) {
      return [rules.filter(r => r.organization_id === params[0] && r.trigger_event === params[1])];
    }
    if (/FROM clients WHERE id = \? AND organization_id = \?/.test(sql)) {
      return [params[0] === CLIENT.id && params[1] === 1 ? [CLIENT] : []];
    }
    if (/FROM contracts WHERE id = \? AND organization_id = \?/.test(sql)) {
      return [params[0] === CONTRACT.id && params[1] === 1 ? [CONTRACT] : []];
    }
    if (/FROM invoices WHERE id = \? AND organization_id = \?/.test(sql)) {
      return [params[0] === 500 && params[1] === 1 ? [{ id: 500 }] : []];
    }
    if (/INSERT INTO tickets/.test(sql)) return [{ insertId: 900, affectedRows: 1 }];
    return [{ affectedRows: 1, insertId: 1 }];
  });
}

const rule = (over = {}) => ({
  id: 3, organization_id: 1, name: 'Overdue follow-up', trigger_event: 'invoice.overdue',
  trigger_conditions: [], action_type: 'create_ticket', action_config: {}, is_enabled: 1, ...over,
});
const executions = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO automation_rule_executions/.test(sql)).map(([, p]) => p);
const ticketInserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO tickets/.test(sql)).map(([, p]) => p);

beforeEach(() => {
  jest.clearAllMocks();
  eventBus.removeAllListeners();
  automationActions._resetForTests();
  rules = [];
  routeDb();
  messageOutbox.enqueue.mockResolvedValue({ queued: true, id: 41 });
  suspensionService.suspendContract.mockResolvedValue({ suspended: true });
});

describe('create_ticket', () => {
  test('opens an automation ticket for the event\'s client, with the configured fields filled from the event', async () => {
    rules = [rule({ action_config: { subject: 'Invoice {{invoice.number}} is overdue', priority: 'high', category: 'billing' } })];
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', {
      invoice: { id: 500, number: 'INV-000500', client_id: 7, contract_id: 70 },
    });
    expect(result).toMatchObject({ evaluated: 1, triggered: 1 });
    expect(ticketInserts()).toEqual([[1, 7, 70, 'Invoice INV-000500 is overdue', expect.stringContaining('automation rule #3'), 'high', 'billing']]);
    expect(businessEvents.emitTicketCreated).toHaveBeenCalledWith(1, expect.objectContaining({ id: 900, source: 'automation' }));
    expect(executions()[0][4]).toBe('success');
    expect(db.query.mock.calls.some(([sql]) => /run_count = run_count \+ 1/.test(sql))).toBe(true);
  });

  test('a client of another organization gets no ticket', async () => {
    rules = [rule()];
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', { client_id: 8 });
    expect(result.triggered).toBe(0);
    expect(ticketInserts()).toEqual([]);
    expect(executions()[0][4]).toBe('skipped');
    expect(executions()[0][5]).toMatch(/no client of this organization/);
  });
});

describe('suspend_contract', () => {
  test('suspends the event\'s contract through suspensionService', async () => {
    rules = [rule({ action_type: 'suspend_contract' })];
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', { invoice: { id: 500, contract_id: 70 } });
    expect(result.triggered).toBe(1);
    expect(suspensionService.suspendContract).toHaveBeenCalledWith(70, null, null, 500);
  });

  test('a contract of another organization is left alone', async () => {
    rules = [rule({ action_type: 'suspend_contract' })];
    await automationService.evaluateAutomationRules(1, 'invoice.overdue', { contract_id: 71 });
    expect(suspensionService.suspendContract).not.toHaveBeenCalled();
    expect(executions()[0][4]).toBe('skipped');
  });

  test('an exempt client\'s skipped suspension is not counted as a run', async () => {
    rules = [rule({ action_type: 'suspend_contract' })];
    suspensionService.suspendContract.mockResolvedValue({ skipped: true, reason: 'vip' });
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', { contract_id: 70 });
    expect(result.triggered).toBe(0);
    expect(executions()[0][5]).toMatch(/not suspended: vip/);
  });
});

describe('send_notification', () => {
  test('queues an SMS to the client through the outbox', async () => {
    rules = [rule({ action_type: 'send_notification', action_config: { channel: 'sms', message: 'Hola {{client.name}}' } })];
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', { client: { id: 7, name: 'Ana' } });
    expect(result.triggered).toBe(1);
    expect(messageOutbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms', organizationId: 1, clientId: 7, messageClass: 'transactional',
      recipient: '+525512345678', bodyText: 'Hola Ana', sourceType: 'automation_rule', sourceId: 3,
    }));
  });

  test('a message the client\'s preferences block is recorded as skipped', async () => {
    rules = [rule({ action_type: 'send_notification', action_config: { message: 'Hi' } })];
    messageOutbox.enqueue.mockResolvedValue({ queued: false, skipped: true, code: 'CLIENT_OPTED_OUT' });
    const result = await automationService.evaluateAutomationRules(1, 'invoice.overdue', { client_id: 7 });
    expect(result.triggered).toBe(0);
    expect(executions()[0][5]).toMatch(/CLIENT_OPTED_OUT/);
  });
});

describe('event triggers', () => {
  test('a business event runs the organization\'s rules for it', async () => {
    rules = [rule({ trigger_event: 'payment.received', action_config: { subject: 'Thanks' } })];
    automationActions.registerAutomationTriggers();
    await eventBus.emit('payment.received', { organizationId: 1, payment: { id: 5, client_id: 7 } });
    expect(ticketInserts()).toHaveLength(1);
    expect(executions()[0][2]).toBe('payment.received');
  });

  test('an event with no rules makes no rule query beyond the cached trigger list', async () => {
    rules = [rule({ trigger_event: 'payment.received' })];
    automationActions.registerAutomationTriggers();
    await eventBus.emit('device.trap', { organizationId: 1 });
    await eventBus.emit('device.trap', { organizationId: 1 });
    const ruleQueries = db.query.mock.calls.filter(([sql]) => /FROM automation_rules/.test(sql));
    expect(ruleQueries).toHaveLength(1);
    expect(executions()).toEqual([]);
  });

  test('an event raised by a rule action does not run rules again', async () => {
    // A ticket.created rule that opens a ticket would loop without the guard.
    const emitTicket = jest.requireActual('../src/services/businessEvents').emitTicketCreated;
    businessEvents.emitTicketCreated.mockImplementation((...args) => emitTicket(...args));
    rules = [rule({ trigger_event: 'ticket.created' })];
    automationActions.registerAutomationTriggers();
    await eventBus.emit('ticket.created', { organizationId: 1, ticket: { id: 1, client_id: 7 } });
    await new Promise(r => setImmediate(r));
    expect(ticketInserts()).toHaveLength(1);
  });

  test('an event without an organization runs nothing', async () => {
    rules = [rule()];
    automationActions.registerAutomationTriggers();
    await eventBus.emit('invoice.overdue', { invoice: { id: 1 } });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('saving rules', () => {
  test('POST refuses an action type that has no handler', async () => {
    const app = require('../src/app');
    const res = await request(app).post('/api/v1/automation-rules').send({
      name: 'X', trigger_event: 'payment.received', action_type: 'run_script',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/create_ticket, suspend_contract, send_notification/);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO automation_rules/.test(sql))).toBe(false);
  });

  test('POST refuses a notification with no message', async () => {
    const app = require('../src/app');
    const res = await request(app).post('/api/v1/automation-rules').send({
      name: 'X', trigger_event: 'payment.received', action_type: 'send_notification', action_config: { channel: 'sms' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/needs action_config.message/);
  });

  test('POST stores a valid rule', async () => {
    const app = require('../src/app');
    const res = await request(app).post('/api/v1/automation-rules').send({
      name: 'X', trigger_event: 'payment.received', action_type: 'create_ticket', action_config: { priority: 'low' },
    });
    expect(res.status).toBe(201);
  });
});
