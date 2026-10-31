// =============================================================================
// FE-05 — the portal session survives the 15-minute access token
// =============================================================================
// Portal access tokens were minted only at login and on a full page load, so
// every portal call (Pay Now included) failed 15 minutes later. Calls now go
// through portalAuthedFetch, which refreshes once on 401 and retries; a
// refused refresh signs the subscriber out.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { PortalAuthProvider, usePortalAuth, portalAuthedFetch, portalTokenStore } from '../PortalAuthContext';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  portalTokenStore.setAccess('expired-access');
  portalTokenStore.setRefresh('refresh-1');
});

const authOf = (init?: RequestInit) => new Headers(init?.headers).get('Authorization');

describe('portalAuthedFetch', () => {
  it('refreshes on 401 and retries with the new token', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/portal/auth/refresh') return json(200, { data: { accessToken: 'fresh-access', refreshToken: 'refresh-2' } });
      return authOf(init) === 'Bearer fresh-access' ? json(200, { data: { payment_url: 'https://pay' } }) : json(401, {});
    });

    const res = await portalAuthedFetch('/api/v1/portal/invoices/9/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' } });

    expect(res.status).toBe(200);
    expect(portalTokenStore.getAccess()).toBe('fresh-access');
    expect(portalTokenStore.getRefresh()).toBe('refresh-2');
    const retry = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(retry[1].method).toBe('POST');
    expect(new Headers(retry[1].headers).get('Content-Type')).toBe('application/json');
  });

  it('concurrent 401s share one refresh (the refresh token rotates)', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/portal/auth/refresh') {
        await new Promise(r => setTimeout(r, 10));
        return json(200, { data: { accessToken: 'fresh-access', refreshToken: 'refresh-2' } });
      }
      return authOf(init) === 'Bearer fresh-access' ? json(200, {}) : json(401, {});
    });

    const results = await Promise.all([1, 2, 3].map(i => portalAuthedFetch(`/api/v1/portal/x/${i}`)));

    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/portal/auth/refresh')).toHaveLength(1);
  });

  it('a transient refresh failure keeps the session', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === '/api/v1/portal/auth/refresh' ? json(503, {}) : json(401, {})));
    const res = await portalAuthedFetch('/api/v1/portal/dashboard');
    expect(res.status).toBe(401);
    expect(portalTokenStore.getRefresh()).toBe('refresh-1');
  });
});

describe('a refused refresh signs the subscriber out', () => {
  function Probe() {
    const { client, initialized } = usePortalAuth();
    return <p>{initialized ? (client ? `in:${client.name}` : 'out') : 'booting'}</p>;
  }

  it('the provider drops the client so PortalRoute shows the login page', async () => {
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/v1/portal/auth/refresh') {
        refreshes += 1;
        // Boot refresh succeeds; the later one (token expired, refresh revoked) is refused.
        return refreshes === 1
          ? json(200, { data: { accessToken: 'boot-access', refreshToken: 'refresh-2' } })
          : json(401, { error: { message: 'Invalid refresh token' } });
      }
      if (url === '/api/v1/portal/auth/me') return json(200, { data: { id: 5, name: 'Ana', email: null, organization_id: 1 } });
      return json(401, {});
    });

    render(<PortalAuthProvider><Probe /></PortalAuthProvider>);
    expect(await screen.findByText('in:Ana')).toBeInTheDocument();

    await act(async () => { await portalAuthedFetch('/api/v1/portal/invoices'); });

    await waitFor(() => expect(screen.getByText('out')).toBeInTheDocument());
    expect(portalTokenStore.getRefresh()).toBeNull();
    expect(portalTokenStore.getAccess()).toBeNull();
  });
});
