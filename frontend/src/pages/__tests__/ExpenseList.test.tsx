// =============================================================================
// VigaBSS 5.0 — ExpenseList page tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ExpenseList } from '../ExpenseList';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
let mockUser: { id: number; role: string; permissions: string[] } = { id: 1, role: 'billing', permissions: ['expenses.view'] };
vi.mock('@/auth/useOrgCurrency', () => ({ useOrgCurrency: () => 'MXN' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args), POST: (...args: unknown[]) => mockApiPost(...args) },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const expense1 = {
  id: 1, category: 'fuel', description: null, amount: '350.00',
  currency: 'MXN', receipt_url: null,
  expense_date: '2024-06-01', notes: null, status: 'pending', user_id: 7,
};

function renderExpenseList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ExpenseList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ExpenseList page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 1, role: 'billing', permissions: ['expenses.view'] };
    mockApiPost.mockResolvedValue({ data: { data: {} }, error: undefined });
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/expenses')
        return Promise.resolve({ data: { data: [expense1], meta: { total: 1, page: 1, limit: 25, totalPages: 1 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
  });

  it('renders the page heading', async () => {
    renderExpenseList();
    await waitFor(() => expect(screen.getByText('💸 Expenses')).toBeInTheDocument());
  });

  it('renders an expense row after data loads', async () => {
    renderExpenseList();
    await waitFor(() => expect(screen.getByText('fuel')).toBeInTheDocument());
  });

  it('shows empty message when no expenses', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/expenses')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    renderExpenseList();
    await waitFor(() => expect(screen.getByText(/No expenses found/)).toBeInTheDocument());
  });

  // TNA-28: approval is its own step, gated on expenses.approve.
  it('offers approve and reject to an approver on someone else\'s pending expense', async () => {
    mockUser = { id: 1, role: 'billing', permissions: ['expenses.view', 'expenses.approve'] };
    renderExpenseList();
    fireEvent.click(await screen.findByText('✅ Approve'));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/expenses/{id}/approve', { params: { path: { id: 1 } } }));
    expect(screen.getByText('✖ Reject')).toBeInTheDocument();
  });

  it('hides approval without expenses.approve and on the user\'s own expense', async () => {
    const { unmount } = renderExpenseList();
    await screen.findByText('fuel');
    expect(screen.queryByText('✅ Approve')).not.toBeInTheDocument();
    unmount();
    mockUser = { id: 7, role: 'billing', permissions: ['expenses.view', 'expenses.approve'] };
    renderExpenseList();
    await screen.findByText('fuel');
    expect(screen.queryByText('✅ Approve')).not.toBeInTheDocument();
  });

  it('the expense form has no status field', async () => {
    renderExpenseList();
    fireEvent.click(await screen.findByText('+ New Expense'));
    expect(screen.queryByText('Status', { selector: 'label' })).not.toBeInTheDocument();
  });
});
