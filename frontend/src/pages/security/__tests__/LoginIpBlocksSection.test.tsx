// =============================================================================
// Blocked IPs at sign-in (migration 013)
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginIpBlocksSection } from '../LoginIpBlocksSection';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/api/client', () => ({
  authedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  api: { GET: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

const activeBlock = {
  id: 5, ip_address: '203.0.113.50', source: 'auto', failures: 20, refused_count: 31,
  blocked_until: '2026-11-09T10:00:00Z', note: '20 failed sign-ins in 60 min', created_by: null,
  lifted_at: null, lifted_by: null, created_at: '2026-11-08T10:00:00Z', active: true,
};
const listBody = {
  data: [activeBlock],
  pagination: { page: 1, limit: 100, total: 1, pages: 1 },
  settings: { enabled: true, threshold: 20, window_minutes: 60, hours: 24 },
  your_ip: '198.51.100.9',
};

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LoginIpBlocksSection /></QueryClientProvider>);
}

describe('LoginIpBlocksSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/security-admin/login-ip-blocks') && (!init || !init.method || init.method === 'GET')) return Promise.resolve(json(listBody));
      return Promise.resolve(json({ data: activeBlock, lifted: true }, 201));
    });
  });

  it('shows nothing to someone who is not the install operator', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(json({ error: { code: 'FORBIDDEN', message: 'Install operator only' } }, 403)));
    const { container } = renderSection();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists the active blocks with the rule in force and the caller\'s IP', async () => {
    renderSection();
    expect(await screen.findByText('203.0.113.50')).toBeInTheDocument();
    expect(screen.getByText('Automatic (20 failures)')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
    expect(screen.getByText(/20 failed sign-ins \(staff, 2FA or portal\) within 60 minutes/)).toBeInTheDocument();
    expect(screen.getByText('198.51.100.9')).toBeInTheDocument();
    expect(String(mockFetch.mock.calls[0][0])).toMatch(/active=true/);
  });

  it('blocks an IP by hand and lifts a block', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText('203.0.113.50');
    await user.type(screen.getByPlaceholderText('203.0.113.5'), '192.0.2.44');
    await user.selectOptions(screen.getByRole('combobox'), 'forever');
    await user.click(screen.getByRole('button', { name: 'Block IP' }));
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(([u, i]) => String(u).endsWith('/security-admin/login-ip-blocks') && i?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]!.body))).toEqual({ ip: '192.0.2.44', hours: null });
    });

    await user.click(screen.getByRole('button', { name: 'Lift block' }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([u, i]) => String(u).endsWith('/security-admin/login-ip-blocks/5/lift') && i?.method === 'POST')).toBe(true));
  });
});
