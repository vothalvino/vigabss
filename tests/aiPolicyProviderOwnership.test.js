'use strict';
// =============================================================================
// Phase 1 ASY-04 — the AI policy may only select this org's own provider
// =============================================================================
// PUT /ai/policy copied active_provider_id straight into ai_policies; the FK
// only proves the id exists. Drafts, triage, portal chat and embeddings then
// called llmProviderService with that id, whose AiProvider.findById had no
// org predicate, so org A ran on org B's decrypted key and endpoint.
// =============================================================================

const request = require('supertest');

jest.mock('../src/config/database', () => ({
  query: jest.fn(), queryReplica: jest.fn(), execute: jest.fn(),
  getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: 1, organizationId: 1, organization_id: 1, email: 'a@b.c', role: 'admin' };
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
jest.mock('../src/middleware/ipAllowlist', () => ({
  ...jest.requireActual('../src/middleware/ipAllowlist'),
  createIpAllowlist: () => (_req, _res, next) => next(),
  parseAllowlist: () => [],
}));
jest.mock('../src/middleware/adminIpAllowlist', () => ({
  enforceAdminIpAllowlist: (_req, _res, next) => next(),
}));

const db = require('../src/config/database');
const app = require('../src/app');
const llmProviderService = require('../src/services/llmProviderService');

// Provider 5 is org 1's; provider 9 is org 2's.
const PROVIDERS = { 5: { id: 5, organization_id: 1 }, 9: { id: 9, organization_id: 2 } };

function wire() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM ai_providers WHERE id = \? AND organization_id = \?/.test(sql)) {
      const p = PROVIDERS[Number(params[0])];
      return [p && p.organization_id === params[1] ? [{ id: p.id }] : []];
    }
    if (/FROM `ai_providers` WHERE id = \?/.test(sql)) {
      const p = PROVIDERS[Number(params[0])];
      const scoped = /organization_id = \?/.test(sql);
      return [p && (!scoped || p.organization_id === params[1]) ? [{ ...p, kind: 'openai', model: 'x' }] : []];
    }
    if (/INSERT INTO ai_policies/.test(sql)) return [{ affectedRows: 1 }];
    if (/FROM ai_policies/.test(sql)) return [[{ organization_id: 1, active_provider_id: 5 }]];
    return [[]];
  });
}

const policyWrites = () => db.query.mock.calls.filter(([s]) => /INSERT INTO ai_policies/.test(s));

beforeEach(() => { jest.clearAllMocks(); wire(); });

describe('PUT /ai/policy', () => {
  it('rejects another org\'s provider with 422 and writes nothing', async () => {
    const res = await request(app).put('/api/v1/ai/policy').send({ active_provider_id: 9, enabled: true });
    expect(res.status).toBe(422);
    expect(policyWrites()).toHaveLength(0);
  });

  it('accepts this org\'s own provider', async () => {
    const res = await request(app).put('/api/v1/ai/policy').send({ active_provider_id: 5 });
    expect(res.status).toBe(200);
    expect(policyWrites()).toHaveLength(1);
  });

  it('checks the provider is enabled and live in this org', async () => {
    await request(app).put('/api/v1/ai/policy').send({ active_provider_id: 5 });
    const [sql, params] = db.query.mock.calls.find(([s]) => /FROM ai_providers WHERE id = \?/.test(s));
    expect(sql).toMatch(/organization_id = \? AND enabled = 1 AND deleted_at IS NULL/);
    expect(params).toEqual([5, 1]);
  });

  it('allows clearing the provider without a lookup', async () => {
    const res = await request(app).put('/api/v1/ai/policy').send({ active_provider_id: null });
    expect(res.status).not.toBe(422);
  });
});

describe('llmProviderService provider lookup', () => {
  it('chat() with an orgId refuses another org\'s provider', async () => {
    await expect(llmProviderService.chat({
      providerId: 9, orgId: 1, messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
    const [sql, params] = db.query.mock.calls.find(([s]) => /FROM `ai_providers`/.test(s));
    expect(sql).toMatch(/organization_id = \?/);
    expect(params).toEqual([9, 1]);
  });

  it('embed() with an orgId refuses another org\'s provider', async () => {
    await expect(llmProviderService.embed('text', 9, { orgId: 1 }))
      .rejects.toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
  });

  it('verify() with an orgId refuses another org\'s provider', async () => {
    await expect(llmProviderService.verify(9, { orgId: 1 }))
      .rejects.toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
  });
});
