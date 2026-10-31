// =============================================================================
// VigaBSS 5.0 — QosBandwidthPage tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { QosBandwidthPage } from '../QosBandwidthPage';

const mockApiGet = vi.fn();
const mockApiPut = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args), POST: vi.fn(), PUT: (...args: unknown[]) => mockApiPut(...args), PATCH: vi.fn(), DELETE: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const qcItem = {
  id: 1, name: 'VoIP', description: 'Voice traffic', traffic_type: 'voip',
  priority: 1, dscp_mark: 'EF', mikrotik_queue_kind: 'pcq', max_limit_pct: null, status: 'active',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <QosBandwidthPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('QosBandwidthPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/quality-classes')
        return Promise.resolve({ data: { data: [qcItem], meta: { total: 1, page: 1, limit: 25 } }, error: undefined });
      return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 25 } }, error: undefined });
    });
  });

  it('renders the page heading', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('QoS & Bandwidth Management')).toBeInTheDocument());
  });

  it('renders quality class tab by default and shows a row', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('VoIP')).toBeInTheDocument());
  });

  it('shows empty message when no quality classes', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/quality-classes')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 25 } }, error: undefined });
      return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 25 } }, error: undefined });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No quality classes found/)).toBeInTheDocument());
  });

  // The route is PUT (there is no PATCH), and the table has is_active, not a
  // status column: edits used to 404 and the status shown was always blank.
  it('edits a bandwidth test server with PUT and is_active', async () => {
    const server = { id: 7, name: 'iperf-mx', host: 'iperf.example.com', port: 5201, protocol: 'iperf3', region: null, site_id: null, is_active: 0 };
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/bandwidth-test-servers')
        return Promise.resolve({ data: { data: [server], meta: { total: 1, page: 1, limit: 25 } }, error: undefined });
      return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 25 } }, error: undefined });
    });
    mockApiPut.mockResolvedValue({ data: { data: server }, error: undefined });
    renderPage();

    fireEvent.click(await screen.findByText('Traffic Engineering'));
    const row = (await screen.findByText('iperf-mx')).closest('tr')!;
    expect(within(row).getByText('inactive')).toBeInTheDocument();
    fireEvent.click(within(row).getByText('Edit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApiPut).toHaveBeenCalled());
    const [path, opts] = mockApiPut.mock.calls[0] as [string, { params: { path: { id: number } }; body: Record<string, unknown> }];
    expect(path).toBe('/bandwidth-test-servers/{id}');
    expect(opts.params.path.id).toBe(7);
    expect(opts.body.is_active).toBe(false);
    expect(opts.body).not.toHaveProperty('status');
  });
});
