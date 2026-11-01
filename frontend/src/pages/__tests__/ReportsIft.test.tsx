// RTE-07: the IFT statistical report form posted and read avg_download_speed,
// avg_upload_speed and revenue, but the table, validator and model use
// avg_download_speed_mbps, avg_upload_speed_mbps and revenue_total. The API kept
// the report and dropped the figures, so every saved report showed '—'.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { Reports } from '../Reports';

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));

vi.mock('@/api/client', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() },
  authedFetch: (...args: unknown[]) => mocks.authedFetch(...args),
}));

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin', organization_locale: 'MX' } }),
}));

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const REPORT = {
  id: 7, report_period: '2026-Q3', status: 'draft',
  avg_download_speed_mbps: 85.5, avg_upload_speed_mbps: 20.25,
  subscribers_by_speed_tier: null, subscribers_by_state: null, subscribers_by_technology: null,
  coverage_municipalities: 4, revenue_total: 125000, created_at: '2026-10-01T00:00:00Z',
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
  mocks.authedFetch.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).includes('/ift-statistical-reports')) {
      return jsonResponse({ data: [REPORT], meta: { total: 1, page: 1, limit: 20 } });
    }
    // Other tabs' data is not under test: let their queries fail cleanly.
    return { ok: false, status: 404, statusText: 'Not Found', json: vi.fn().mockResolvedValue({}) } as unknown as Response;
  });
});

async function openIft() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <Reports />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole('button', { name: /IFT Statistical/ }));
  return user;
}

describe('IFT statistical reports', () => {
  it('renders the stored speeds and revenue', async () => {
    await openIft();
    expect(await screen.findByText('85.5')).toBeInTheDocument();
    expect(screen.getByText('20.25')).toBeInTheDocument();
    expect(screen.getByText(/125,000/)).toBeInTheDocument();
  });

  it('posts the field names the API stores', async () => {
    const user = await openIft();
    await user.click(screen.getByRole('button', { name: '+ New Report' }));
    await user.type(screen.getAllByRole('textbox')[0], '2026-Q4');
    const [down, up, , revenue] = screen.getAllByRole('spinbutton');
    await user.type(down, '90');
    await user.type(up, '25');
    await user.type(revenue, '1500');
    await user.click(screen.getByRole('button', { name: 'Create Report' }));

    await waitFor(() => {
      expect(mocks.authedFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
    const [, init] = mocks.authedFetch.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({ avg_download_speed_mbps: 90, avg_upload_speed_mbps: 25, revenue_total: 1500 });
    expect(body).not.toHaveProperty('avg_download_speed');
    expect(body).not.toHaveProperty('revenue');
  });
});
