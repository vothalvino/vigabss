// =============================================================================
// Settings / Alert Rules — canonical RF metrics and safe defaults
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '../Settings';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/auth/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/AuthContext')>()),
  useAuth: () => ({
    user: {
      id: 1, email: 'admin@example.test', name: 'Admin', role: 'admin',
      organization_id: 1, is_active: true, email_verified_at: null, twofa_enabled: false,
    },
    loading: false, initialized: true,
    login: vi.fn(), logout: vi.fn(), refresh: vi.fn(), switchOrganization: vi.fn(),
  }),
}));

vi.mock('@/api/client', () => ({
  authedFetch: vi.fn().mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  ),
}));

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><Settings /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/alerts/rules')) return ok({ data: [], meta: { total: 0 } });
    return ok({ data: [] });
  });
});

describe('Settings alert-rule editor', () => {
  it('offers every canonical RF gauge, ==, and no cumulative-octet pseudo-bandwidth option', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Alert Rules/ }));
    fireEvent.click(await screen.findByRole('button', { name: '+ New Rule' }));

    const metric = screen.getByLabelText(/Metric/) as HTMLSelectElement;
    const metricValues = Array.from(metric.options).map(option => option.value);
    expect(metric.value).toBe('cpu_usage');
    expect(metricValues).toEqual(expect.arrayContaining([
      'signal_strength', 'noise_floor_dbm', 'snr_db', 'ccq_pct',
      'air_util_pct', 'gps_sync_status', 'tx_rate_mbps', 'rx_rate_mbps',
    ]));
    expect(metricValues).not.toEqual(expect.arrayContaining([
      'bandwidth_in', 'bandwidth_out', 'if_in_octets', 'if_out_octets',
      'if_in_discards', 'if_out_discards',
    ]));

    expect(screen.getByLabelText(/Threshold \*/)).toHaveValue(90);

    const operator = screen.getByLabelText(/Operator/) as HTMLSelectElement;
    expect(Array.from(operator.options).map(option => option.value)).toContain('==');
    expect(Array.from(operator.options).map(option => option.value)).not.toContain('=');
  });

  it('submits canonical RF names and operators unchanged', async () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Alert Rules/ }));
    fireEvent.click(await screen.findByRole('button', { name: '+ New Rule' }));

    fireEvent.change(screen.getByLabelText(/Name \*/), { target: { value: 'Low C5c SNR' } });
    fireEvent.change(screen.getByLabelText(/Metric/), { target: { value: 'snr_db' } });
    fireEvent.change(screen.getByLabelText(/Operator/), { target: { value: '<' } });
    fireEvent.change(screen.getByLabelText(/Threshold \*/), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const post = mockFetch.mock.calls.find(([url, init]) =>
        String(url).endsWith('/api/v1/alerts/rules') && init?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toEqual(expect.objectContaining({
        name: 'Low C5c SNR', metric: 'snr_db', operator: '<', threshold: 15,
      }));
    });
  });
});
