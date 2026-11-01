// FE-16: the typed client's refresh-and-retry re-sent the Request openapi-fetch
// had already sent. Its body stream was consumed, so every POST/PUT/PATCH that
// hit a 401 failed with "Cannot construct a Request with a Request object that
// has already been used" instead of being retried after the refresh.
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('api refresh-and-retry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('retries a POST after a refresh with the same body', async () => {
    const bodies: string[] = [];
    let first = true;
    // openapi-fetch captures globalThis.fetch and Request when the client is
    // created, so stub before importing it. Node's Request needs an absolute URL.
    const NativeRequest = globalThis.Request;
    vi.stubGlobal('Request', class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = typeof input === 'object' && 'url' in input ? (input as Request) : new Request(String(input), init);
      if (req.url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ data: { accessToken: 'fresh', refreshToken: 'r' } }), { status: 200 });
      }
      bodies.push(await req.text());
      if (first) {
        first = false;
        return new Response('{"error":"expired"}', { status: 401 });
      }
      expect(req.headers.get('Authorization')).toBe('Bearer fresh');
      return new Response(JSON.stringify({ data: { id: 1 } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));
    const { api, tokenStore } = await import('@/api/client');
    tokenStore.setAccess('stale');

    const res = await api.POST('/tickets' as never, { body: { subject: 'No service', client_id: 10 } } as never) as { data?: unknown; response: Response };

    expect(res.response.status).toBe(201);
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1])).toEqual({ subject: 'No service', client_id: 10 });
    expect(bodies[1]).toBe(bodies[0]);
  });
});
