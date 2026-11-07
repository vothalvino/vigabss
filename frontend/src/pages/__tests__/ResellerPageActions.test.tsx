// The Resellers list shows Suspend/Delete only to users whose permissions
// allow them: a reseller user holds resellers.view alone, and saw buttons
// that could only answer 403.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockUser: { role: string; permissions?: string[] } = { role: 'admin' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
vi.mock('@/api/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({
    data: [{ id: 1, name: 'E2E Reseller A', level: 1, parent_name: null, commission_rate: '10.00', portal_name: null, status: 'active' }],
    meta: { total: 1, page: 1, limit: 25, totalPages: 1 },
  })),
}));

import ResellerPage from '../ResellerPage';

// The page shares react-query caches with its other tabs, as under App.
const renderPage = () => render(<QueryClientProvider client={new QueryClient()}><ResellerPage /></QueryClientProvider>);

beforeEach(() => { mockUser = { role: 'admin' }; });

describe('ResellerPage — Resellers tab actions', () => {
  it('a reseller user sees the list without Suspend or Delete', async () => {
    mockUser = { role: 'billing', permissions: ['resellers.view', 'reseller_portal.dashboard'] };
    renderPage();
    await waitFor(() => expect(screen.getByText('E2E Reseller A')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /suspend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('an admin sees both', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('E2E Reseller A')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /suspend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('suspend without delete shows only Suspend', async () => {
    mockUser = { role: 'billing', permissions: ['resellers.view', 'resellers.suspend'] };
    renderPage();
    await waitFor(() => expect(screen.getByText('E2E Reseller A')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /suspend/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
