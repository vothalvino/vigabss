// FE-15: the staff app and the portal share one QueryClient, and portal query
// keys are not per subscriber. Subscriber B logging in on the same browser
// was shown subscriber A's dashboard, usage and invoices until a refetch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortalAuthProvider, usePortalAuth, portalTokenStore } from '../PortalAuthContext';

const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

describe('portal sign-in changes drop the previous subscriber’s cached data', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}><PortalAuthProvider>{children}</PortalAuthProvider></QueryClientProvider>
  );

  beforeEach(() => {
    vi.restoreAllMocks();
    portalTokenStore.clear();
    localStorage.clear();
    queryClient = new QueryClient();
    queryClient.setQueryData(['portal-dashboard'], { client: { name: 'Subscriber A' }, balance: 580 });
    queryClient.setQueryData(['portal-invoices', 1, ''], { data: [{ id: 7, invoice_number: 'A-7' }] });
    queryClient.setQueryData(['clients'], { data: [] }); // staff data is not touched
  });

  it('on login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      data: { accessToken: 'a', refreshToken: 'r', client: { id: 2, name: 'Subscriber B', email: null, organization_id: 1 } },
    }));
    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true));
    await act(() => result.current.login('b@example.com', 'pw'));

    expect(queryClient.getQueryData(['portal-dashboard'])).toBeUndefined();
    expect(queryClient.getQueryData(['portal-invoices', 1, ''])).toBeUndefined();
    expect(queryClient.getQueryData(['clients'])).toEqual({ data: [] });
  });

  it('on logout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}));
    const { result } = renderHook(() => usePortalAuth(), { wrapper });
    await waitFor(() => expect(result.current.initialized).toBe(true));
    queryClient.setQueryData(['portal-dashboard'], { client: { name: 'Subscriber A' } });
    await act(() => result.current.logout());

    expect(queryClient.getQueryData(['portal-dashboard'])).toBeUndefined();
  });
});
