// =============================================================================
// VigaBSS 5.0 — ConfigTemplateList deploy flow (NET-09)
// =============================================================================
// The backend has no automatic config push: POST /config-templates/:id/deploy
// returns status 'pending', push_performed=false and the rendered config. The
// page must say nothing was sent to the device and must never claim success.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ConfigTemplateList } from '../ConfigTemplateList';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
vi.mock('@/api/client', () => ({
  api: {
    GET: (...args: unknown[]) => mockApiGet(...args),
    POST: (...args: unknown[]) => mockApiPost(...args),
  },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const template = {
  id: 3, name: 'Core identity', description: null, device_type: 'router', manufacturer: 'MikroTik',
  template_content: '/system identity set name={{hostname}}', status: 'active',
};

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConfigTemplateList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function submitDeploy() {
  renderList();
  await waitFor(() => expect(screen.getByText('Core identity')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  const deviceInput = await screen.findByRole('spinbutton');
  fireEvent.change(deviceInput, { target: { value: '55' } });
  fireEvent.submit(deviceInput.closest('form') as HTMLFormElement);
}

describe('ConfigTemplateList deploy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { data: [template], meta: { total: 1, page: 1, limit: 25 } }, error: undefined });
  });

  it('shows the honest not-pushed state and the rendered config, never "deployed successfully"', async () => {
    mockApiPost.mockResolvedValue({
      data: {
        data: {
          id: 901, status: 'pending', push_performed: false,
          result_output: 'Automatic push is not available yet; apply the rendered config manually',
          rendered_config: '/system identity set name=core-1',
        },
      },
      error: undefined,
    });
    await submitDeploy();

    await waitFor(() => expect(screen.getByText(/Automatic push is not available yet/)).toBeInTheDocument());
    expect(screen.getByText(/Nothing was sent to the device/)).toBeInTheDocument();
    expect(screen.getByText('Deployment status: pending')).toBeInTheDocument();
    expect(screen.getByLabelText('Rendered configuration')).toHaveValue('/system identity set name=core-1');
    expect(screen.queryByText(/deployed successfully/i)).not.toBeInTheDocument();
    expect(mockApiPost).toHaveBeenCalledWith('/config-templates/{id}/deploy', expect.objectContaining({
      params: { path: { id: 3 } },
      body: { device_id: 55, variables: null },
    }));
  });

  it('shows an error when the deploy is refused (e.g. device not in this organization)', async () => {
    mockApiPost.mockResolvedValue({ data: undefined, error: { error: 'devices not found' } });
    await submitDeploy();
    await waitFor(() => expect(screen.getByText('Failed to render the config template for this device.')).toBeInTheDocument());
    expect(screen.queryByText(/Rendered configuration/)).not.toBeInTheDocument();
  });
});
