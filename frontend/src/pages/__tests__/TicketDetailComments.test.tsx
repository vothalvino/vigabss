// =============================================================================
// DB-23 — the ticket comment form shows only to those who may post
// =============================================================================
// POST /tickets/:id/comments needs tickets.comment (technician, migration 483)
// or tickets.update; the form rendered for everyone, so a role without either
// typed a comment only to get a 403.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TicketDetail } from '../TicketDetail';
import * as AuthContextModule from '@/auth/AuthContext';
import type { AuthUser } from '@/auth/AuthContext';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const assignableUsers = [{ id: 42, first_name: 'Ana', last_name: 'Technician' }];
const genericUsers = [{ id: 7, first_name: 'Bob', last_name: 'GenericStaff' }];

vi.mock('@/api/client', () => ({
  api: {
    GET: vi.fn(async (path: string) => {
      // Exact-match first: '/work-orders/assignable-users' would also match
      // a naive `.includes('/users')` check below.
      if (path === '/work-orders/assignable-users') return { data: { data: assignableUsers }, error: null };
      if (path.includes('/tickets/')) return { data: { data: ticket1 }, error: null };
      if (path.includes('/clients/')) return { data: { data: client1 }, error: null };
      if (path === '/users') return { data: { data: genericUsers }, error: null };
      return { data: { data: null }, error: null };
    }),
  },
  tokenStore: {
    getAccess: () => 'test-token',
    setAccess: vi.fn(),
    getRefresh: () => null,
    setRefresh: vi.fn(),
    clear: vi.fn(),
  },
  authedFetch: vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
}));

vi.mock('@/api/useWebSocket',           () => ({ useWebSocket:           vi.fn(() => ({ lastMessage: null })) }));
vi.mock('@/api/useGraphQLSubscription', () => ({ useGraphQLSubscription: vi.fn(() => ({ data: null })) }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminUser: AuthUser = {
  id: 1, email: 'admin@test.com', name: 'Admin', role: 'admin',
  organization_id: 1, is_active: true, email_verified_at: '2026-01-01T00:00:00.000Z', twofa_enabled: false,
};

const ticket1 = {
  id: 99,
  client_id: 5,
  contract_id: null,
  assigned_to: null,
  subject: 'Internet very slow',
  description: 'Speed drops after 9 PM',
  priority: 'high',
  category: 'connectivity',
  status: 'open',
  notes: null,
  created_at: '2026-04-01T08:00:00Z',
  updated_at: '2026-04-01T09:00:00Z',
};

const client1 = { id: 5, name: 'Jane Doe', email: 'jane@example.com' };

function makeJsonOk(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function mockFetchImpl() {
  // Every raw-fetch sub-resource on the page (comments, ticket-scoped work
  // orders, escalations, follow-ups, time logs, AI endpoints) — an empty
  // list is a safe default for all of them.
  mockFetch.mockImplementation(() => Promise.resolve(makeJsonOk({ data: [] })));
}

function renderTicketDetail(user: AuthUser = adminUser) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user,
    loading: false,
    initialized: true,
    login: vi.fn(),
    completeMfaLogin: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    switchOrganization: vi.fn(),
  } as ReturnType<typeof AuthContextModule.useAuth>);

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tickets/99']}>
        <Routes>
          <Route path="/tickets/:id" element={<TicketDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const withPermissions = (role: string, permissions: string[]) =>
  ({ ...adminUser, role, permissions } as AuthUser);

describe('TicketDetail — comment form gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a technician with tickets.comment gets the comment form', async () => {
    mockFetchImpl();
    renderTicketDetail(withPermissions('technician', ['tickets.view', 'tickets.comment']));
    await waitFor(() => expect(screen.queryByText(/Internet very slow/i)).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Post Comment' })).toBeInTheDocument();
  });

  it('a view-only role does not', async () => {
    mockFetchImpl();
    renderTicketDetail(withPermissions('readonly', ['tickets.view']));
    await waitFor(() => expect(screen.queryByText(/Internet very slow/i)).toBeTruthy(), { timeout: 3000 });
    expect(screen.queryByRole('button', { name: 'Post Comment' })).not.toBeInTheDocument();
  });
});
