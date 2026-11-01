// FE-17: the staff AuthProvider wraps the whole router, so its boot probe ran
// on every portal page load (four failed /auth requests charged to the per-IP
// session budget subscribers share), and a portal boot that ran out of
// retries on 429 threw away a refresh token that was probably still valid.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../AuthContext';
import { PortalAuthProvider, usePortalAuth, portalTokenStore } from '../PortalAuthContext';

const wrap = (Provider: typeof AuthProvider) => function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}><Provider>{children}</Provider></QueryClientProvider>;
};
const status = (code: number) => ({ ok: code < 400, status: code, headers: new Headers(), json: () => Promise.resolve({}) } as Response);

describe('session probes', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); portalTokenStore.clear(); });
  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('the staff provider does not probe on portal pages', async () => {
    window.history.pushState({}, '', '/portal/dashboard');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(401));
    const { result } = renderHook(() => useAuth(), { wrapper: wrap(AuthProvider) });
    await waitFor(() => expect(result.current.initialized).toBe(true));
    expect(result.current.user).toBeNull();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/v1/auth/'))).toHaveLength(0);
  });

  it('a staff page with no session settles after one denied refresh', async () => {
    window.history.pushState({}, '', '/login');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(401));
    const { result } = renderHook(() => useAuth(), { wrapper: wrap(AuthProvider) });
    await waitFor(() => expect(result.current.initialized).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(2); // /me, /refresh — no race re-check without a CSRF cookie
  });

  it('a rate-limited portal boot keeps the refresh token for the next load', async () => {
    portalTokenStore.setRefresh('still-valid');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(status(429));
    const { result } = renderHook(() => usePortalAuth(), { wrapper: wrap(PortalAuthProvider as typeof AuthProvider) });
    await waitFor(() => expect(result.current.initialized).toBe(true), { timeout: 5000 });
    expect(result.current.client).toBeNull();
    expect(portalTokenStore.getRefresh()).toBe('still-valid');
  });
});
