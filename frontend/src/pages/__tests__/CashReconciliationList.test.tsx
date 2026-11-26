// =============================================================================
// VigaBSS 5.0 — CashReconciliationList page tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CashReconciliationList } from '../CashReconciliationList';

const mockApiGet = vi.fn();
vi.mock('@/api/client', () => ({
  api: {
    GET: (...args: unknown[]) => mockApiGet(...args),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin' } }),
}));

const session1 = {
  id: 1,
  agent_user_id: 3,
  status: 'open',
  opened_at: '2024-01-01T10:00:00Z',
  closed_at: null,
  expected_total: null,
  counted_total: null,
  variance: null,
  notes: null,
};

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CashReconciliationList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CashReconciliationList page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/cash-reconciliation/sessions')
        return Promise.resolve({ data: { data: [session1], meta: { total: 1, page: 1, limit: 50, totalPages: 1 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
  });

  it('renders the page title', async () => {
    renderList();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cashier' })).toBeInTheDocument());
  });

  it('shows the "Open Cashier" button when user has admin role', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('+ Open Cashier')).toBeInTheDocument());
  });

  it('renders a table row when session data is returned', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    // Without a name the owner is shown by number.
    await waitFor(() => expect(screen.getByText('#3')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument());
  });
  it('shows the owner of a cashier by name, with the number beside it', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/cash-reconciliation/sessions')
        return Promise.resolve({ data: { data: [{ ...session1, agent_name: 'Ana Ruiz' }], meta: { total: 1, page: 1, limit: 50, totalPages: 1 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    renderList();
    const name = await screen.findByText('Ana Ruiz');
    expect(name.closest('td')).toHaveTextContent('Ana Ruiz #3');
  });

  describe('reviewing a count', () => {
    const withSessions = (rows: Record<string, unknown>[]) => mockApiGet.mockImplementation((path: string) => {
      if (path === '/cash-reconciliation/sessions')
        return Promise.resolve({ data: { data: rows, meta: { total: rows.length, page: 1, limit: 50, totalPages: 1 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    const closed = { ...session1, status: 'closed', closed_at: '2024-01-01T18:00:00Z', expected_total: '300.00', counted_total: '280.00', variance: '-20.00' };

    it('offers Approve and Dispute on someone else\'s count that did not match', async () => {
      withSessions([{ ...closed, id: 5, agent_user_id: 3 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#5')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Dispute' })).toBeInTheDocument();
    });

    it('opens the review dialog, which asks for a note', async () => {
      withSessions([{ ...closed, id: 5, agent_user_id: 3 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#5')).toBeInTheDocument());
      screen.getByRole('button', { name: 'Dispute' }).click();
      expect(await screen.findByRole('dialog', { name: 'Dispute this count' })).toBeInTheDocument();
      expect(screen.getByLabelText('Note')).toBeInTheDocument();
    });

    it('does not let a supervisor review their own cashier', async () => {
      withSessions([{ ...closed, id: 6, agent_user_id: 1 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#6')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dispute' })).not.toBeInTheDocument();
      expect(screen.getByText('Another supervisor reviews your own cashier')).toBeInTheDocument();
    });

    it('a disputed count can still be approved, but not disputed again', async () => {
      withSessions([{ ...closed, id: 7, agent_user_id: 3, status: 'disputed', approved_by: 9 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#7')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dispute' })).not.toBeInTheDocument();
    });

    it('marks a matched count as approved automatically and offers nothing to review', async () => {
      withSessions([
        { ...closed, id: 8, status: 'approved', variance: '0.00', counted_total: '300.00', approved_by: null },
        { ...closed, id: 9, status: 'approved', approved_by: 4 },
      ]);
      renderList();
      await waitFor(() => expect(screen.getByText('#8')).toBeInTheDocument());
      expect(screen.getByText('Approved · matched')).toBeInTheDocument();
      expect(screen.getByText('Approved')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });
  });
});
