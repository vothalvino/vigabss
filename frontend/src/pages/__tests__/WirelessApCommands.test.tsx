// =============================================================================
// NET-22 — AP command jobs are cancelled, not "deleted"
// =============================================================================
// The row's Delete sent DELETE /wireless/ap-commands/{id}, a route that does
// not exist; the 404 was swallowed and the row stayed. A pending or queued job
// now offers Cancel (POST …/cancel), and a failure is shown.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WirelessManagementPage } from '../WirelessManagementPage';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiDelete = vi.fn();
vi.mock('@/api/client', () => ({
  api: {
    GET: (...a: unknown[]) => mockApiGet(...a),
    POST: (...a: unknown[]) => mockApiPost(...a),
    PUT: vi.fn(),
    DELETE: (...a: unknown[]) => mockApiDelete(...a),
  },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const jobs = [
  { id: 1, device_id: 3, command_type: 'reboot', target_value: null, status: 'pending', notes: null, created_at: '2026-11-01', completed_at: null },
  { id: 2, device_id: 3, command_type: 'reboot', target_value: null, status: 'completed', notes: null, created_at: '2026-11-01', completed_at: '2026-11-01' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mockApiGet.mockImplementation((path: string) => Promise.resolve({
    data: path === '/wireless/ap-commands' ? { data: jobs, meta: { total: 2 } } : { data: [], meta: { total: 0 } },
    error: undefined,
  }));
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><WirelessManagementPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'AP Commands' }));
}

describe('AP command jobs', () => {
  it('offers Cancel only on a pending job and posts to the cancel route', async () => {
    mockApiPost.mockResolvedValue({ data: { data: { ...jobs[0], status: 'cancelled' } }, error: undefined });
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: 'Cancel job' });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith(
      '/wireless/ap-commands/{id}/cancel', expect.objectContaining({ params: { path: { id: 1 } } }),
    ));
    expect(mockApiDelete).not.toHaveBeenCalled();
  });

  it('shows a failed cancel instead of swallowing it', async () => {
    mockApiPost.mockResolvedValue({ data: undefined, error: { error: { code: 'CONFLICT', message: 'Only pending or queued jobs can be cancelled' } } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only pending or queued jobs can be cancelled');
  });
});
