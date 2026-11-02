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
});
