// =============================================================================
// ASY-11 — an AI provider's endpoint_url cannot reach internal services
// =============================================================================
// ollama and custom providers POSTed with fetch() to whatever endpoint_url a
// tenant admin saved: loopback, private ranges, cloud metadata, redirects
// followed. A non-2xx body went into the error, and verify() returned it in a
// 502, so POST /ai/providers/:id/verify read internal HTTP services.
// =============================================================================

const http = require('http');

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(),
  pool: { end: jest.fn() }, withPrimaryContext: (fn) => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/models/AiProvider', () => ({ findById: jest.fn(), findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin', organizationId: 1 }; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({ orgScope: (req, _res, next) => { req.orgId = 1; next(); } }));
jest.mock('../src/middleware/rbac', () => ({
  ...jest.requireActual('../src/middleware/rbac'),
  requirePermission: () => (_req, _res, next) => next(),
}));

const request = require('supertest');
const AiProvider = require('../src/models/AiProvider');
const { safeJsonPost } = require('../src/utils/safeJsonPost');
const llm = require('../src/services/llmProviderService');

let server;
let port;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (req.url === '/internal') { res.writeHead(403); res.end('INTERNAL-ADMIN-PAGE secret=hunter2'); return; }
    if (req.url === '/huge') { res.writeHead(200); res.end('x'.repeat(64 * 1024)); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise((r) => server.close(r)));
afterEach(() => { delete process.env.AI_PROVIDER_ALLOWED_HOSTS; });

describe('safeJsonPost', () => {
  test.each([
    'http://127.0.0.1:11434/api/chat',
    'https://127.0.0.1/api/chat',
    'https://10.0.0.5/v1/chat',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/v1/chat',
    'https://localhost/v1/chat',
    'http://api.example.com/v1/chat',
  ])('refuses %s', async (url) => {
    await expect(safeJsonPost(url, {})).rejects.toMatchObject({ statusCode: 422, code: 'UNSAFE_URL' });
  });

  test('an operator-allowed host may be local and plain http', async () => {
    process.env.AI_PROVIDER_ALLOWED_HOSTS = `ollama.lan, 127.0.0.1:${port}`;
    const res = await safeJsonPost(`http://127.0.0.1:${port}/api/chat`, { model: 'x' });
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(res.text).choices[0].message.content).toBe('ok');
  });

  test('the allowance is per host and port', async () => {
    process.env.AI_PROVIDER_ALLOWED_HOSTS = '127.0.0.1:1';
    await expect(safeJsonPost(`http://127.0.0.1:${port}/api/chat`, {})).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  test('redirects are not followed', async () => {
    process.env.AI_PROVIDER_ALLOWED_HOSTS = `127.0.0.1:${port}`;
    const res = await safeJsonPost(`http://127.0.0.1:${port}/redirect`, {});
    expect(res).toMatchObject({ ok: false, status: 302 });
  });

  test('the response size is capped', async () => {
    process.env.AI_PROVIDER_ALLOWED_HOSTS = `127.0.0.1:${port}`;
    await expect(safeJsonPost(`http://127.0.0.1:${port}/huge`, {}, {}, { maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('verify()', () => {
  const provider = (endpoint) => ({
    id: 4, organization_id: 1, kind: 'custom', model: 'm', endpoint_url: endpoint,
    api_key_encrypted: null, extra_config: null, timeout_ms: 5000,
  });

  test('a refused endpoint is a 422, not a fetched page', async () => {
    AiProvider.findById.mockResolvedValue(provider(`http://127.0.0.1:${port}/internal`));
    await expect(llm.verify(4, { orgId: 1 })).rejects.toMatchObject({ statusCode: 422, code: 'UNSAFE_URL' });
  });

  test('an upstream error body never reaches the caller', async () => {
    process.env.AI_PROVIDER_ALLOWED_HOSTS = `127.0.0.1:${port}`;
    AiProvider.findById.mockResolvedValue(provider(`http://127.0.0.1:${port}/internal`));
    const err = await llm.verify(4, { orgId: 1 }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 502 });
    expect(err.message).toMatch(/HTTP 403/);
    expect(err.message).not.toMatch(/INTERNAL-ADMIN-PAGE|hunter2/);
  });
});

describe('saving a provider', () => {
  const app = require('../src/app');

  test('a custom provider pointing at a private address is refused', async () => {
    const res = await request(app).post('/api/v1/ai/providers')
      .send({ name: 'x', kind: 'custom', model: 'm', endpoint_url: 'https://10.1.2.3/v1/chat' });
    expect(res.status).toBe(422);
    expect(AiProvider.create).not.toHaveBeenCalled();
  });

  test('an ollama provider on the local default needs the operator allowance', async () => {
    const refused = await request(app).post('/api/v1/ai/providers').send({ name: 'o', kind: 'ollama', model: 'llama3' });
    expect(refused.status).toBe(422);

    process.env.AI_PROVIDER_ALLOWED_HOSTS = 'localhost:11434';
    AiProvider.create.mockResolvedValue({ id: 9, kind: 'ollama' });
    const allowed = await request(app).post('/api/v1/ai/providers').send({ name: 'o', kind: 'ollama', model: 'llama3' });
    expect(allowed.status).toBe(201);
  });

  test('editing the endpoint is checked too', async () => {
    AiProvider.findById.mockResolvedValue({ id: 4, organization_id: 1, kind: 'custom', endpoint_url: 'https://api.example.com/v1' });
    const res = await request(app).put('/api/v1/ai/providers/4').send({ endpoint_url: 'https://192.168.1.1/admin' });
    expect(res.status).toBe(422);
    expect(AiProvider.update).not.toHaveBeenCalled();
  });
});
