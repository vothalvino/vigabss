// =============================================================================
// VigaBSS 5.0 — Cashier page (one line per person) and a person's page
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CashReconciliationList } from '../CashReconciliationList';
import { CashierPersonPage } from '../cashier/CashierPersonPage';

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

const auth = vi.hoisted(() => ({ user: { id: 1, role: 'admin' } as { id: number; role: string; permissions?: string[] } }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
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

const ana = {
  user_id: 3, name: 'Ana Ruiz', open: true, cash_on_hand: 1400, last_session_id: 1, last_closed_at: null,
  current: {
    session_id: 1, opened_at: '2024-01-01T10:00:00Z', hours_open: 2, opening_total: 500, opening_expected: 500,
    opening_difference: 0, collected_total: 1200, pickups_total: 300, pending_pickups: 0, pending_pickups_total: 0,
  },
  awaiting_review: 0, disputed: 0, status: 'ok', reasons: [] as string[],
};
const beto = {
  user_id: 4, name: 'Beto Luna', open: false, cash_on_hand: 820.5, last_session_id: 9, last_closed_at: '2024-01-01T18:00:00Z',
  current: null, awaiting_review: 1, disputed: 0, status: 'mismatch', reasons: ['closing_difference'],
};

function wrap(ui: React.ReactNode, at = '/cash-reconciliation') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/cash-reconciliation" element={ui} />
          <Route path="/cash-reconciliation/staff/:userId" element={<CashierPersonPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const renderList = () => wrap(<CashReconciliationList />);
const renderPerson = (id = 3) => wrap(<CashReconciliationList />, `/cash-reconciliation/staff/${id}`);

function people(rows: Record<string, unknown>[]) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === '/cash-reconciliation/staff') return Promise.resolve({ data: { data: rows, meta: { scope: 'everyone' } }, error: undefined });
    return Promise.resolve({ data: { data: [] }, error: undefined });
  });
}
function personPage({ person = ana, scope = 'full', sessions = [session1] as Record<string, unknown>[] } = {}) {
  mockApiGet.mockImplementation((path: string) => {
    if (path === '/cash-reconciliation/staff/{userId}')
      return Promise.resolve({ data: { data: { person, scope, rules: { max_open_hours: 16, pickup_threshold: 0, pickup_strict: false }, sessions } }, error: undefined });
    return Promise.resolve({ data: { data: [] }, error: undefined });
  });
}

describe('Cashier page: one line per person', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { id: 1, role: 'admin' };
    people([ana, beto]);
  });

  it('renders the page title', async () => {
    renderList();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Cashier' })).toBeInTheDocument());
  });

  it('shows the "Open Cashier" button when user has admin role', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('+ Open Cashier')).toBeInTheDocument());
  });

  it('shows one line per person with the cash in their drawer', async () => {
    renderList();
    const anaRow = await screen.findByTestId('cashier-person-3');
    expect(anaRow).toHaveTextContent('Ana Ruiz');
    expect(anaRow).toHaveTextContent('$1,400.00');
    expect(anaRow).toHaveTextContent(/Open since/);
    const betoRow = screen.getByTestId('cashier-person-4');
    expect(betoRow).toHaveTextContent('Beto Luna');
    expect(betoRow).toHaveTextContent('$820.50');
    expect(betoRow).toHaveTextContent(/Closed/);
    expect(mockApiGet.mock.calls.some(([path]) => path === '/cash-reconciliation/sessions')).toBe(false);
  });

  it('a green dot when all is well, a red one with the reason when not', async () => {
    renderList();
    const anaRow = await screen.findByTestId('cashier-person-3');
    expect(anaRow.querySelector('[data-status]')).toHaveAttribute('data-status', 'ok');
    expect(anaRow.querySelector('[data-status]')).toHaveAccessibleName('All good');
    const betoRow = screen.getByTestId('cashier-person-4');
    expect(betoRow.querySelector('[data-status]')).toHaveAttribute('data-status', 'mismatch');
    expect(betoRow.querySelector('[data-status]')).toHaveAccessibleName('Needs a look');
    expect(betoRow).toHaveTextContent('1 count did not match');
    expect(screen.getByText('1 needs a look')).toBeInTheDocument();
  });

  it('names every reason of a red dot', async () => {
    people([{ ...ana, status: 'mismatch', reasons: ['opening_difference', 'over_limit', 'open_too_long'], current: { ...ana.current, opening_difference: -50, hours_open: 17 } }]);
    renderList();
    const row = await screen.findByTestId('cashier-person-3');
    expect(row).toHaveTextContent('Opened with -$50.00 difference from the last close');
    expect(row).toHaveTextContent('Over the cash limit');
    expect(row).toHaveTextContent('Open for 17 hours');
  });

  it("a line opens that person's page", async () => {
    personPage();
    people([ana]);
    renderList();
    const row = await screen.findByTestId('cashier-person-3');
    expect(row.querySelector('a')).toHaveAttribute('href', '/cash-reconciliation/staff/3');
  });

  it('does not offer to open a cashier to someone who already has one open', async () => {
    people([{ ...ana, user_id: 1 }]);
    renderList();
    await screen.findByTestId('cashier-person-1');
    expect(screen.queryByText('+ Open Cashier')).not.toBeInTheDocument();
  });

  it('says so when nobody has a cashier', async () => {
    people([]);
    renderList();
    expect(await screen.findByText('Nobody has opened a cashier yet.')).toBeInTheDocument();
  });
});

describe("a person's cashier page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.user = { id: 1, role: 'admin' };
    personPage();
  });

  it('shows the person, the cash in the drawer now and where it comes from', async () => {
    renderPerson();
    expect(await screen.findByRole('heading', { name: 'Ana Ruiz' })).toBeInTheDocument();
    expect(screen.getByTestId('cash-on-hand')).toHaveTextContent('$1,400.00');
    expect(screen.getByText('Cash in the drawer now')).toBeInTheDocument();
    expect(screen.getByText('Cash taken since').parentElement).toHaveTextContent('$1,200.00');
    expect(screen.getByText('Picked up by supervisors').parentElement).toHaveTextContent('$300.00');
    expect(mockApiGet).toHaveBeenCalledWith('/cash-reconciliation/staff/{userId}', { params: { path: { userId: 3 } } });
  });

  it('full scope lists every cashier; a supervisor is told what is left out', async () => {
    renderPerson();
    expect(await screen.findByText('Every cashier of this person')).toBeInTheDocument();
    expect(screen.queryByText(/shown to the administrator only/)).not.toBeInTheDocument();
  });

  it("a supervisor's view says the settled counts are for the administrator", async () => {
    personPage({ scope: 'supervisor' });
    renderPerson();
    expect(await screen.findByText('Open cashier and counts to review')).toBeInTheDocument();
    expect(screen.getByText(/shown to the administrator only/)).toBeInTheDocument();
  });

  it('a closed cashier shows the last count', async () => {
    personPage({ person: beto as never, sessions: [] });
    renderPerson(4);
    expect(await screen.findByText('Cash in the drawer (last count)')).toBeInTheDocument();
    expect(screen.getByTestId('cash-on-hand')).toHaveTextContent('$820.50');
    expect(screen.getByText('1 count did not match')).toBeInTheDocument();
  });

  it('a person the caller may not see reads as not found', async () => {
    mockApiGet.mockResolvedValue({ data: undefined, error: { error: { code: 'NOT_FOUND' } } });
    renderPerson(99);
    expect(await screen.findByText('This cashier was not found, or you may not see it.')).toBeInTheDocument();
  });

  it('renders a table row when session data is returned', async () => {
    renderPerson();
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
    // Without a name the owner is shown by number.
    await waitFor(() => expect(screen.getByText('#3')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument());
  });

  it('shows the owner of a cashier by name, with the number beside it', async () => {
    personPage({ sessions: [{ ...session1, agent_name: 'Ana Ruiz' }] });
    renderPerson();
    await screen.findByText('#1');
    const cell = screen.getAllByText('Ana Ruiz').map(el => el.closest('td')).find(Boolean);
    expect(cell).toHaveTextContent('Ana Ruiz #3');
  });

  describe('reviewing a count', () => {
    const withSessions = (rows: Record<string, unknown>[]) => personPage({ sessions: rows });
    const renderList = () => renderPerson();
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

    it('does not let a manager review their own cashier', async () => {
      auth.user = { id: 1, role: 'manager', permissions: ['cash_reconciliation.view', 'cash_reconciliation.approve'] };
      withSessions([{ ...closed, id: 6, agent_user_id: 1 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#6')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dispute' })).not.toBeInTheDocument();
      expect(screen.getByText('Another supervisor reviews your own cashier')).toBeInTheDocument();
    });

    it('lets the company\'s admin, who has nobody above them, review their own cashier', async () => {
      withSessions([{ ...closed, id: 6, agent_user_id: 1 }]);
      renderList();
      await waitFor(() => expect(screen.getByText('#6')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Dispute' })).toBeInTheDocument();
      expect(screen.queryByText('Another supervisor reviews your own cashier')).not.toBeInTheDocument();
    });

    it('marks a review made by the cashier\'s own owner', async () => {
      withSessions([{ ...closed, id: 6, agent_user_id: 1, status: 'approved', approved_by: 1, approved_by_name: 'Ana Ruiz', review_note: 'faltaron 20, los repuse' }]);
      renderList();
      (await screen.findByText('#6')).click();
      const note = await screen.findByText(/faltaron 20, los repuse/);
      expect(note.closest('td')).toHaveTextContent('Ana Ruiz');
      expect(note.closest('td')).toHaveTextContent('reviewed by the owner of this cashier');
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
