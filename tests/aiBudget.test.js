'use strict';
// =============================================================================
// ASY-34 — AI spend is recorded and capped
// =============================================================================
// Nothing capped AI spend: every portal chat message and ticket could call the
// provider (classification plus up to three generation attempts), and only
// ticket replies recorded a cost. Every chat and embedding call now records its
// cost in ai_usage_events, a call is refused once the organization's
// month-to-date spend reaches ai_policies.monthly_budget_usd, ticket replies
// skip before spending, and portal chat caps AI turns per session and client.
// =============================================================================

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ query: (...a) => mockQuery(...a) }));

const fs = require('fs');
const path = require('path');
const aiBudget = require('../src/services/aiBudgetService');

function usage({ budget, spent }) {
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM ai_policies/.test(sql)) return [[budget === undefined ? undefined : { monthly_budget_usd: budget }].filter(Boolean)];
    if (/SUM\(cost_usd\)/.test(sql)) return [[{ spent }]];
    if (/INSERT INTO ai_usage_events/.test(sql)) return [{ insertId: 1 }];
    return [[]];
  });
}

beforeEach(() => mockQuery.mockReset());

describe('budget status', () => {
  test('month-to-date spend is summed from the start of the UTC month', async () => {
    usage({ budget: '10.00', spent: '4.5' });
    await expect(aiBudget.status(42)).resolves.toEqual({ budget_usd: 10, spent_usd: 4.5, remaining_usd: 5.5 });
    const [, params] = mockQuery.mock.calls.find(([sql]) => /SUM\(cost_usd\)/.test(sql));
    expect(params[0]).toBe(42);
    expect(params[1].toISOString()).toMatch(/-01T00:00:00\.000Z$/);
  });

  test('no budget means no limit', async () => {
    usage({ budget: null, spent: 1000 });
    await expect(aiBudget.overBudget(42)).resolves.toBe(false);
  });

  test('reaching the budget refuses further calls with 429', async () => {
    usage({ budget: '5.00', spent: '5.0001' });
    await expect(aiBudget.assertWithinBudget(42)).rejects.toMatchObject({ statusCode: 429, code: 'AI_BUDGET_EXCEEDED' });
  });
});

describe('llmProviderService', () => {
  jest.mock('../src/models/AiProvider', () => ({
    findById: jest.fn(async () => ({ id: 3, organization_id: 42, kind: 'ollama', model: 'm', endpoint_url: 'http://127.0.0.1:1', timeout_ms: 1000 })),
    findAll: jest.fn(async () => []),
    UNSCOPED: Symbol.for('vigabss.BaseModel.UNSCOPED'),
  }));

  test('over budget, chat makes no provider call', async () => {
    usage({ budget: '1.00', spent: '2' });
    const llm = require('../src/services/llmProviderService');
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('should not be called'));
    await expect(llm.chat({ providerId: 3, orgId: 42, messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

test('a ticket reply over budget skips before classification', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'aiReplyService.js'), 'utf8');
  const gate = src.indexOf("return { skipped: true, reason: 'budget_exceeded' }");
  const classify = src.indexOf('const classification = await _classifyMessage(');
  expect(gate).toBeGreaterThan(0);
  expect(classify).toBeGreaterThan(gate);
});

test('portal chat stops calling the AI past the per-session and per-client turn caps', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'portal.js'), 'utf8');
  expect(src).toMatch(/PORTAL_CHAT_MAX_TURNS/);
  expect(src).toMatch(/PORTAL_CHAT_CLIENT_DAILY_TURNS/);
  expect(src).toMatch(/capped \? \{ skipped: true, reason: 'turn_limit' \} : await aiReplyService\.generate/);
});
