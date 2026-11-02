// =============================================================================
// VigaBSS 5.0 — PortalAuthContext tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PortalAuthProvider, usePortalAuth, portalTokenStore } from '../PortalAuthContext';

function wrapper({ children }: { children: ReactNode }) {
  return <PortalAuthProvider>{children}</PortalAuthProvider>;
}

function mockFetch(responses: Array<{ ok: boolean; json?: object; status?: number }>) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const r = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve({
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 401),
      json: () => Promise.resolve(r.json ?? {}),
    } as Response);
  });
}

const client = { id: 1, name: 'Acme Co', email: 'c@acme.com', organization_id: 1 };

describe('PortalAuthContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    portalTokenStore.clear();
    localStorage.clear();
  });

  it('settles logged-out when no portal session is remembered', async () => {
    const fetchSpy = mockFetch([{ ok: true, json: { data: client } }]);
    const { result } = renderHook(() => usePortalAuth(), { wrapper });

    await waitFor(() => expect(result.current.initialized).toBe(true));
    expect(result.current.client).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // no session → no network call
  });

  it('restores the session: refresh then /me', async () => {
    portalTokenStore.markSession();
    mockFetch([
      { ok: true, json: { data: { accessToken: 'pa', refreshToken: 'pr2' } } }, // POST /portal/auth/refresh
      { ok: true, json: { data: client } },                                     // GET /portal/auth/me
    ]);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true));

    expect(result.current.client).toMatchObject({ id: 1, name: 'Acme Co' });
    expect(portalTokenStore.getAccess()).toBe('pa');
  });

  it('does NOT bounce to login on a transient 429 during refresh — retries then restores', async () => {
    portalTokenStore.markSession();
    mockFetch([
      { ok: false, status: 429 },                                               // refresh → rate-limited (transient)
      { ok: true, json: { data: { accessToken: 'pa', refreshToken: 'pr2' } } }, // retry refresh → ok
      { ok: true, json: { data: client } },                                     // me → ok
    ]);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true), { timeout: 3000 });

    expect(result.current.client).toMatchObject({ id: 1 });
  });

  it('logs out on a definitive 401 refresh (expired / invalid token)', async () => {
    portalTokenStore.markSession();
    mockFetch([{ ok: false, status: 401 }]);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true));

    expect(result.current.client).toBeNull();
    expect(portalTokenStore.hasSession()).toBe(false); // cleared
  });

  // SEC-28: the refresh token is an httpOnly cookie. The SPA sends no token
  // and stores none; localStorage holds only the session flag.
  it('refreshes with the cookie and never stores a token', async () => {
    portalTokenStore.markSession();
    const fetchSpy = mockFetch([
      { ok: true, json: { data: { accessToken: 'pa' } } },
      { ok: true, json: { data: client } },
    ]);

    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.client).not.toBeNull());

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/portal/auth/refresh');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' });
    expect(Object.keys(localStorage)).toEqual(['fireisp_portal_session']);
  });

  it('login remembers the session but not the token, even if the server sends one', async () => {
    mockFetch([{ ok: true, json: { data: { accessToken: 'pa', refreshToken: 'leaked', client } } }]);
    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true));

    await act(() => result.current.login('c@acme.com', 'pw'));

    expect(result.current.client).toMatchObject({ id: 1 });
    expect(JSON.stringify({ ...localStorage })).not.toContain('leaked');
    expect(portalTokenStore.hasSession()).toBe(true);
  });
});
