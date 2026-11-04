// =============================================================================
// A fake API behind the real fetch boundary (FE-24)
// =============================================================================
// Most page tests mock '@/api/client' wholesale, so the token attach, the
// silent refresh on 401 and the retry never ran under a page, and fixtures
// were whatever shape the test author assumed. This stubs globalThis.fetch
// only: pages go through the real client.ts / PortalAuthContext code. Routes
// answer like the server does: an access token is checked on every route that
// needs one, a stale or missing token is a 401, and POST …/auth/refresh issues
// a new one. Fixtures should be mysql2-shaped (DECIMAL as strings, 0/1 for
// booleans, DATE as UTC midnight).
// =============================================================================

import { vi } from 'vitest';

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}
export type FakeAnswer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

export function fakeServer({ token = 'access-1', refreshPath = '/api/v1/auth/refresh' } = {}) {
  let current = token;
  let issued = 1;
  const routes = new Map<string, Handler>();
  const log: FakeRequest[] = [];
  let refreshAllowed = true;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), 'http://localhost');
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const raw = init?.body ?? (request && method !== 'GET' ? await request.clone().text() : undefined);
    let body: unknown = raw;
    if (typeof raw === 'string' && raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const req: FakeRequest = { method, path: url.pathname, query: url.searchParams, headers, body };
    log.push(req);

    const reply = ({ status = 200, body: out, headers: h = {} }: FakeAnswer) => new Response(
      out === undefined ? null : typeof out === 'string' ? out : JSON.stringify(out),
      { status, headers: { 'Content-Type': typeof out === 'string' ? 'text/plain' : 'application/json', ...h } },
    );

    if (method === 'POST' && url.pathname === refreshPath) {
      if (!refreshAllowed) return reply({ status: 401, body: { error: { message: 'Session expired' } } });
      current = `access-${++issued}`;
      return reply({ body: { data: { accessToken: current } } });
    }
    const handler = routes.get(`${method} ${url.pathname}`);
    if (!handler) return reply({ status: 404, body: { error: { code: 'NOT_FOUND', message: `${method} ${url.pathname}` } } });
    if (headers.get('Authorization') !== `Bearer ${current}`) {
      return reply({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } } });
    }
    return reply(await handler(req));
  });

  return {
    fetch: fetchMock,
    /** Register a route: on('GET /api/v1/x', req => ({ body })) */
    on(route: string, handler: Handler | FakeAnswer) {
      routes.set(route, typeof handler === 'function' ? handler : () => handler);
      return this;
    },
    /** The access token a fresh refresh would hand out is the only valid one. */
    expireToken() { current = `access-expired-${issued}`; },
    denyRefresh() { refreshAllowed = false; },
    get token() { return current; },
    requests(route?: string) {
      return route ? log.filter(r => `${r.method} ${r.path}` === route) : log;
    },
  };
}
