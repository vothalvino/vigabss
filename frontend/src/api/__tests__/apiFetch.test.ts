// =============================================================================
// FE-20 — one apiFetch for hand-written REST calls
// =============================================================================
// Sixteen pages each had their own apiFetch; half used bare fetch with a token
// read from localStorage keys nothing ever wrote, so they sent an empty Bearer
// and never refreshed, two called the unversioned /api, and the audit export
// saved the error body as the export file. The shared helper goes through
// authedFetch; a scan keeps the old patterns from coming back.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { apiFetch, apiUrl, ApiRequestError } from '@/api/apiFetch';
import { tokenStore } from '@/api/client';

describe('apiFetch', () => {
  beforeEach(() => {
    tokenStore.clear();
    vi.restoreAllMocks();
  });

  it('prefixes /api/v1 and leaves a full /api URL alone', () => {
    expect(apiUrl('/clients')).toBe('/api/v1/clients');
    expect(apiUrl('/api/v1/ai/policy')).toBe('/api/v1/ai/policy');
  });

  it('goes through authedFetch: bearer token, cookies and refresh on 401', async () => {
    tokenStore.setAccess('tok-1');
    let first = true;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/auth/refresh')) {
        tokenStore.setAccess('tok-2');
        return new Response(JSON.stringify({ data: { accessToken: 'tok-2', refreshToken: 'r' } }), { status: 200 });
      }
      if (first) { first = false; return new Response('{}', { status: 401 }); }
      return new Response('{"data":[1]}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/automation-rules')).resolves.toEqual({ data: [1] });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/automation-rules');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-1');
    expect(new Headers(init.headers).has('X-Org-Id')).toBe(false);
    expect(init.credentials).toBe('include');
    const retry = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(new Headers(retry[1].headers).get('Authorization')).toBe('Bearer tok-2');
  });

  it("throws the server's message with the status", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Missing permission audit_export.view' } }), { status: 403 }),
    ));
    const err = (await apiFetch('/audit-logs/export').catch((e: unknown) => e)) as ApiRequestError;
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.status).toBe(403);
    expect(err.message).toBe('Missing permission audit_export.view');
  });

  it('returns null for an empty body and sends FormData without a JSON content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();
    form.append('file', new Blob(['a,b']), 'x.csv');

    await expect(apiFetch('/import/devices/upload', { method: 'POST', body: form })).resolves.toBeNull();
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).has('Content-Type')).toBe(false);
  });
});

describe('no page reaches the API around the shared transport', () => {
  const root = path.resolve(__dirname, '../..');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  })(root);
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
  // The transport itself, the auth bootstrap, and the signed-out pages that
  // call public endpoints before any session exists.
  const ALLOWED_BARE_FETCH = new Set([
    'api/client.ts', 'api/graphql.ts', 'api/csrf.ts', 'auth/AuthContext.tsx', 'auth/PortalAuthContext.tsx',
    'pages/ForgotPassword.tsx', 'pages/ResetPassword.tsx', 'pages/VerifyEmail.tsx',
    // The customer signs through the ISP's link without any session (migration 009).
    'pages/PublicSigning.tsx',
    'pages/portal/PortalForgotPassword.tsx', 'pages/portal/PortalResetPassword.tsx',
  ]);

  it('no local apiFetch copies', () => {
    const copies = files.filter(f => /\b(?:async function apiFetch|const apiFetch\s*=)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel).filter(f => f !== 'api/apiFetch.ts');
    expect(copies).toEqual([]);
  });

  it('no bare fetch of /api outside the transport and the signed-out pages', () => {
    const bare = files.filter(f => /\bfetch\(\s*[`'"](?:\/api|\$\{API)/.test(fs.readFileSync(f, 'utf8')))
      .map(rel).filter(f => !ALLOWED_BARE_FETCH.has(f));
    expect(bare).toEqual([]);
  });

  it('no token or organization read from web storage, and no X-Org-Id header', () => {
    const found = files.filter(f => /(?:local|session)Storage\.getItem\(\s*['"](?:token|orgId)['"]|['"]X-Org-Id['"]/.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(found).toEqual([]);
  });
});
