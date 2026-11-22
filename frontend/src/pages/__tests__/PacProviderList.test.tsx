// =============================================================================
// VigaBSS 5.0 — PacProviderList page tests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PacProviderList } from '../PacProviderList';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
vi.mock('@/api/client', () => ({
  api: {
    GET: (...args: unknown[]) => mockApiGet(...args),
    POST: (...args: unknown[]) => mockApiPost(...args),
    PUT: (...args: unknown[]) => mockApiPut(...args),
  },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

let installMode: 'live' | 'test' = 'live';
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, install_mode: installMode } }) }));

const pac1 = {
  id: 1, provider_name: 'finkok', label: 'Finkok Producción', environment: 'production',
  api_url: 'https://facturacion.finkok.com', is_default: 1, status: 'active', last_stamp_at: null,
  has_username: true, has_password: true,
};

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PacProviderList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PacProviderList page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMode = 'live';
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/pac-providers')
        return Promise.resolve({ data: { data: [pac1], meta: { total: 1, page: 1, limit: 50, totalPages: 1 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
  });

  it('renders the page heading', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('🧾 PAC Providers')).toBeInTheDocument());
  });

  it('renders a provider row with its label', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('Finkok Producción')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('production')).toBeInTheDocument());
  });

  it('shows empty message when no providers', async () => {
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/pac-providers')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } }, error: undefined });
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    renderList();
    await waitFor(() => expect(screen.getByText(/No PAC providers configured/)).toBeInTheDocument());
  });

  it('creates a provider: the preset URL is the live one and no environment is chosen or sent', async () => {
    mockApiPost.mockResolvedValue({ data: { data: { id: 2 } }, error: undefined });
    renderList();
    await screen.findByText('Finkok Producción');
    fireEvent.click(screen.getByRole('button', { name: '+ New provider' }));

    // A live install: sw_sapien's production endpoint, and nothing to pick.
    expect((screen.getByLabelText(/API URL/) as HTMLInputElement).value).toBe('https://services.sw.com.mx');
    expect(screen.queryByLabelText(/Environment/)).toBeNull();
    expect(screen.queryByRole('option', { name: 'simulator' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'SW Sapien' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'sw-user' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sw-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/pac-providers', expect.objectContaining({
      body: expect.objectContaining({
        provider_name: 'sw_sapien',
        api_url: 'https://services.sw.com.mx', label: 'SW Sapien',
        // Plaintext write-only fields: the server encrypts them (BIL-08).
        username: 'sw-user', password: 'sw-pass', status: 'active',
      }),
    })));
    const body = (mockApiPost.mock.calls[0][1] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('environment');
    expect(body).not.toHaveProperty('username_encrypted');
    expect(body).not.toHaveProperty('password_encrypted');
  });

  it('on a test install: the sandbox preset, the simulator, and a note that nothing is valid before SAT', async () => {
    installMode = 'test';
    renderList();
    await screen.findByText('Finkok Producción');
    expect(screen.getByRole('status')).toHaveTextContent(/DEV MODE/);
    fireEvent.click(screen.getByRole('button', { name: '+ New provider' }));
    expect((screen.getByLabelText(/API URL/) as HTMLInputElement).value).toBe('https://services.test.sw.com.mx');
    expect(screen.getByRole('option', { name: 'simulator' })).toBeInTheDocument();
  });

  it('a live install shows no test note', async () => {
    renderList();
    await screen.findByText('Finkok Producción');
    expect(screen.queryByText(/DEV MODE/)).toBeNull();
  });

  it('edit: blank credential fields are OMITTED (write-only, never clobber saved secrets)', async () => {
    mockApiPut.mockResolvedValue({ data: { data: pac1 }, error: undefined });
    renderList();
    await screen.findByText('Finkok Producción');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // Saved credentials show as placeholders, not values
    expect(screen.getByLabelText('Username')).toHaveAttribute('placeholder', 'saved — leave blank to keep');
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'saved — leave blank to keep');
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: 'Finkok prod (renamed)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApiPut).toHaveBeenCalled());
    const body = (mockApiPut.mock.calls[0][1] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('username');
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('username_encrypted');
    expect(body).not.toHaveProperty('password_encrypted');
    expect(body.label).toBe('Finkok prod (renamed)');
  });
});
