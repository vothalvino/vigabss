'use strict';

// =============================================================================
// TNA-40 — escalation chains escalate from the scheduled evaluator
// =============================================================================
// Escalation ran only inside the manual evaluate-v2 endpoint, alert-rule create
// and update never accepted escalation_chain_id, and nothing took the later
// steps. A rule can now name a chain of its own organization; a new episode
// on the scheduled path takes step 1, and advanceEscalations takes each later
// step once its delay has passed while the alert is still unacknowledged.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database');
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, organization_id: 1, role: 'admin' };
    next();
  },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = 1; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  userHasPermission: async () => true,
  requirePermission: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const db = require('../src/config/database');
const eventBus = require('../src/services/eventBus');
const app = require('../src/app');
const alertService = require('../src/services/alertService');

// Answer by statement, not by position.
function route(handlers) {
  db.query.mockImplementation(async (sql, params) => {
    for (const [pattern, answer] of handlers) {
      if (pattern.test(sql)) return typeof answer === 'function' ? answer(sql, params) : answer;
    }
    return [[]];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('alert rules accept an escalation chain of their own organization', () => {
  const rule = { name: 'CPU', metric: 'cpu_usage', threshold: 90 };

  test('a chain of another organization is refused', async () => {
    route([[/FROM alert_escalation_chains WHERE id = \? AND organization_id = \?/, [[]]]]);
    const res = await request(app).post('/api/v1/alerts/rules').send({ ...rule, escalation_chain_id: 77 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ESCALATION_CHAIN_NOT_FOUND');
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO alert_rules/.test(sql))).toBe(false);
  });

  test('the organization\'s own chain is stored on create and update', async () => {
    route([
      [/FROM alert_escalation_chains WHERE id = \? AND organization_id = \?/, (_s, p) => [p[1] === 1 ? [{ id: p[0] }] : []]],
      [/INSERT INTO alert_rules/, [{ insertId: 5 }]],
      [/UPDATE alert_rules SET/, [{ affectedRows: 1 }]],
      [/SELECT \* FROM alert_rules/, [[{ id: 5, escalation_chain_id: 3 }]]],
    ]);
    const created = await request(app).post('/api/v1/alerts/rules').send({ ...rule, escalation_chain_id: 3 });
    expect(created.status).toBe(201);
    const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO alert_rules/.test(sql));
    expect(insert[0]).toMatch(/escalation_chain_id/);
    expect(insert[1]).toContain(3);

    const updated = await request(app).put('/api/v1/alerts/rules/5').send({ escalation_chain_id: 4 });
    expect(updated.status).toBe(200);
    const update = db.query.mock.calls.find(([sql]) => /UPDATE alert_rules SET/.test(sql));
    expect(update[0]).toMatch(/`escalation_chain_id` = \?/);
    expect(update[1]).toContain(4);
  });
});

describe('the scheduled evaluator escalates', () => {
  test('a new episode of a rule with a chain takes step 1', async () => {
    const emit = jest.spyOn(eventBus, 'emit').mockResolvedValue(undefined);
    const escalated = (payload) => emit.mock.calls.filter(([event]) => event === 'alert.escalated').map(([, p]) => p).some(p => Object.entries(payload).every(([k, v]) => p[k] === v));
    route([
      [/FROM alert_rules WHERE organization_id = \?/, [[{
        id: 1, organization_id: 1, name: 'CPU', metric: 'cpu_usage', operator: '>', threshold: 90,
        device_id: 5, duration_minutes: 5, escalation_chain_id: 3, is_enabled: 1,
      }]]],
      [/FROM snmp_metrics/, [[{ device_id: 5, avg_value: 99, max_value: 99 }]]],
      [/INSERT INTO alert_events/, [{ insertId: 10 }]],
      [/FROM alert_escalation_steps s/, (_s, p) => [p[0] === 1 && p[2] === 1 ? [{ chain_id: 3, step_number: 1, notification_channel: 'email' }] : []]],
      [/UPDATE alert_events SET escalation_step/, [{ affectedRows: 1 }]],
    ]);
    try {
      await alertService.evaluateAlerts(1);
      expect(escalated({ alertEventId: 10, escalationChainId: 3, stepNumber: 1 })).toBe(true);
    } finally {
      emit.mockRestore();
    }
  });

  test('advanceEscalations takes the next step of a due, unacknowledged alert', async () => {
    const emit = jest.spyOn(eventBus, 'emit').mockResolvedValue(undefined);
    const escalated = (payload) => emit.mock.calls.filter(([event]) => event === 'alert.escalated').map(([, p]) => p).some(p => Object.entries(payload).every(([k, v]) => p[k] === v));
    route([
      [/JOIN alert_escalation_steps s\s+ON s\.chain_id = c\.id AND s\.step_number = ae\.escalation_step \+ 1/,
        [[{ id: 10, escalation_chain_id: 3, step_number: 2 }]]],
      [/FROM alert_escalation_steps s/, [[{ chain_id: 3, step_number: 2, notification_channel: 'sms' }]]],
      [/UPDATE alert_events SET escalation_step/, [{ affectedRows: 1 }]],
    ]);
    try {
      expect(await alertService.advanceEscalations(1)).toBe(1);
      const due = db.query.mock.calls[0][0];
      expect(due).toMatch(/ae\.status = 'triggered'/);
      expect(due).toMatch(/ae\.escalated_at <= NOW\(\) - INTERVAL s\.delay_minutes MINUTE/);
      expect(escalated({ alertEventId: 10, stepNumber: 2 })).toBe(true);
    } finally {
      emit.mockRestore();
    }
  });

  test('a step is never taken through a chain of another organization, or twice', async () => {
    route([[/FROM alert_escalation_steps s/, [[]]]]);
    expect(await alertService.triggerEscalation(10, 3, 1, 2)).toBe(false);
    expect(db.query.mock.calls[0][1]).toEqual([2, 3, 1]);

    route([
      [/FROM alert_escalation_steps s/, [[{ chain_id: 3, step_number: 1 }]]],
      [/UPDATE alert_events SET escalation_step/, [{ affectedRows: 0 }]],
    ]);
    expect(await alertService.triggerEscalation(10, 3, 1, 1)).toBe(false);
  });
});
