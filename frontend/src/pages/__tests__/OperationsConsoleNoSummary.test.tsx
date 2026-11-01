// FE-08: billing and support land on the Operations Console, but
// /dashboard/summary needs audit_logs.view, which those roles lack. The 403
// put the console in demo mode — 12,847 clients, MRR 4.28M, 214 overdue —
// discarding the real MRR and overdue data they can read, and the demo
// "New ticket" created nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as AuthContextModule from '@/auth/AuthContext';
import type { AuthUser } from '@/auth/AuthContext';
import { OperationsConsole } from '../OperationsConsole';

const mockApiGet = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args) },
  tokenStore: { getAccess: () => 't', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const billing: AuthUser = {
  id: 2, email: 'b@test.com', name: 'Billing', role: 'billing', organization_id: 1,
  is_active: true, email_verified_at: '2026-01-01T00:00:00.000Z', twofa_enabled: false,
  permissions: ['invoices.view', 'tickets.view', 'tickets.create', 'clients.view'],
} as AuthUser;

describe('OperationsConsole without the summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({ user: billing } as ReturnType<typeof AuthContextModule.useAuth>);
    mockApiGet.mockImplementation((path: string) => {
      if (path.includes('summary')) return Promise.resolve({ data: undefined, error: { error: { code: 'FORBIDDEN' } }, response: { status: 403 } });
      if (path.includes('mrr')) return Promise.resolve({ data: { data: [{ currency: 'MXN', active_contracts: 3, mrr: '1500', arpu: '500' }] }, error: undefined });
      if (path.includes('overdue')) return Promise.resolve({ data: { data: [] }, error: undefined });
      if (path.includes('device-health')) return Promise.resolve({ data: { data: { devices_by_type: [], health_snapshots: [] } }, error: undefined });
      if (path.includes('live-sessions')) return Promise.resolve({ data: { data: { total: 0, rows: [] } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
  });

  it('shows the live figures it can load, never the demo ones', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><OperationsConsole /></MemoryRouter>
      </QueryClientProvider>,
    );
    // The billing user's own MRR, not the demo 4.28M.
    await waitFor(() => expect(document.body.textContent).toContain('MRR$1.5K'));
    expect(screen.queryByText('12,847')).toBeNull();
    expect(screen.queryByText('Demo data')).toBeNull();
  });

  it('New ticket opens the real ticket flow', async () => {
    vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
      user: { ...billing, role: 'support', permissions: undefined },
    } as ReturnType<typeof AuthContextModule.useAuth>);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<OperationsConsole />} />
            <Route path="/tickets" element={<div>Tickets page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'New ticket' }));
    expect(await screen.findByText('Tickets page')).toBeInTheDocument();
  });
});
