// =============================================================================
// VigaBSS 5.0 — AuditLogList page tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AuditLogList } from '../AuditLogList';

const mockApiGet = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args) },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

let mockUser: { is_install_operator?: boolean } = {};
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

const log1 = {
  id: 1, user_id: 4, action: 'update', entity_type: 'clients', entity_id: 12,
  summary: 'Updated client email', ip_address: '10.0.0.1', created_at: '2026-05-31T10:00:00Z',
};

const ACTIONS = [
  { action: 'update', category: 'records', count: 7, last_at: null },
  { action: 'login_failed', category: 'sign_in', count: 3, last_at: null },
  { action: 'portal_login_success', category: 'sign_in', count: 2, last_at: null },
  { action: 'brand_new_thing', category: 'other', count: 1, last_at: null },
];

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditLogList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AuditLogList page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {};
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/audit-logs')
        return Promise.resolve({ data: { data: [log1], meta: { total: 1, page: 1, limit: 50 } }, error: undefined });
      if (path === '/audit-logs/actions') return Promise.resolve({ data: { data: ACTIONS, categories: [] }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
  });

  it('renders the page heading', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('📜 Audit Logs')).toBeInTheDocument());
  });

  it('renders an audit log row with its summary', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Updated client email')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('clients')).toBeInTheDocument());
  });

  it('shows empty message when no logs', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/audit-logs')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 50 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    renderList();
    await waitFor(() => expect(screen.getByText(/No audit log entries found/)).toBeInTheDocument());
  });

  // ASY-38: the hash chain can be checked from the page, and the install
  // operator can read the events that belong to no organization.
  it('verifies the hash chain and reports an intact log', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/audit-logs/verify') {
        return Promise.resolve({ data: { data: { intact: true, checked: 42, last_seq: 42, unchained: 0, problems: [] } }, error: undefined });
      }
      return Promise.resolve({ data: { data: [log1], meta: { total: 1, page: 1, limit: 50 } }, error: undefined });
    });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Audit log intact: 42 entries checked');
    expect(mockApiGet).toHaveBeenCalledWith('/audit-logs/verify', { params: { query: { scope: 'organization' } } });
  });

  it('lists what broke when the chain does not verify', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/audit-logs/verify') {
        return Promise.resolve({ data: { data: { intact: false, checked: 3, last_seq: 3, unchained: 0, problems: [
          { id: 7, chain_seq: 2, problem: 'row content does not match its hash' },
        ] } }, error: undefined });
      }
      return Promise.resolve({ data: { data: [log1], meta: { total: 1, page: 1, limit: 50 } }, error: undefined });
    });
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Verify integrity' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Audit log integrity problem: 1 finding');
    expect(status).toHaveTextContent('#7 (position 2): row content does not match its hash');
  });

  it('only the install operator can switch to install-wide events', async () => {
    renderList();
    await screen.findByText('Updated client email');
    expect(screen.queryByLabelText(/install-wide events/)).not.toBeInTheDocument();
  });

  it('the install operator lists install-wide events', async () => {
    mockUser = { is_install_operator: true };
    renderList();
    fireEvent.click(await screen.findByLabelText('Show install-wide events (no organization)'));
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/audit-logs', {
      params: { query: expect.objectContaining({ scope: 'install', page: 1 }) },
    }));
  });

  // Migration 013: the filter lists the actions that occur, grouped by
  // category, with readable labels, and a whole category can be picked.
  it('offers the actions that occur, grouped by category, with labels', async () => {
    renderList();
    const select = screen.getAllByRole('combobox')[0];
    await waitFor(() => expect(screen.getByRole('option', { name: 'Staff sign-in failed (3)' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'All Sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Brand new thing (1)' })).toBeInTheDocument();
    expect(select.querySelector('optgroup[label="Sign-in"]')).not.toBeNull();
  });

  it('filters by a whole category or by one action', async () => {
    renderList();
    const select = screen.getAllByRole('combobox')[0];
    await screen.findByRole('option', { name: 'All Sign-in' });
    fireEvent.change(select, { target: { value: 'category:sign_in' } });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/audit-logs', { params: { query: expect.objectContaining({ category: 'sign_in' }) } }));
    fireEvent.change(select, { target: { value: 'login_failed' } });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/audit-logs', { params: { query: expect.objectContaining({ action: 'login_failed' }) } }));
  });

  it('shows a sign-in event with its label and the IP from the event', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/audit-logs') {
        return Promise.resolve({ data: { data: [{ ...log1, id: 2, action: 'login_failed', ip_address: null, new_values: { ip: '203.0.113.7' } }], meta: { total: 1, page: 1, limit: 50 } }, error: undefined });
      }
      if (path === '/audit-logs/actions') return Promise.resolve({ data: { data: ACTIONS, categories: [] }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    renderList();
    expect(await screen.findByTitle('login_failed')).toHaveTextContent('Staff sign-in failed');
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });
});
