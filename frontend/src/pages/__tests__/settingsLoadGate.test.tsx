// =============================================================================
// FE-03 — settings forms never save defaults over settings they failed to load
// =============================================================================
// InvoiceSettings, PaymentReminderSettings and TaxReports sent
// `Authorization: Bearer ${token}` with raw fetch. After a reload the token is
// null, so the header was "Bearer null", every load failed with 401 and was
// never refreshed, and both settings forms quietly showed hard-coded defaults
// that Save then wrote over the real configuration. The pages now use
// authedFetch, and the forms show an error and keep Save disabled until the
// stored settings have loaded.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InvoiceSettings } from '../InvoiceSettings';
import { PaymentReminderSettings } from '../PaymentReminderSettings';

const mockAuthedFetch = vi.fn();
vi.mock('@/api/client', () => ({
  tokenStore: { getAccess: () => null, setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}));

function renderWithQuery(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe.each([
  ['InvoiceSettings', () => <InvoiceSettings />, '/api/v1/invoice-settings', { logo_url: null, header_color: '#123456', footer_legal: null, payment_instructions: null }],
  ['PaymentReminderSettings', () => <PaymentReminderSettings />, '/api/v1/payment-reminder-settings', { days_before_due: [3], send_on_due: true, days_after_due: [1], enabled: true }],
])('%s', (_name, page, url, stored) => {
  beforeEach(() => { mockAuthedFetch.mockReset(); });

  it('loads through authedFetch (no raw Bearer header)', async () => {
    mockAuthedFetch.mockImplementation(() => json(200, stored));
    renderWithQuery(page());
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledWith(url));
  });

  it('a failed load shows an error and keeps Save disabled', async () => {
    mockAuthedFetch.mockImplementation(() => json(401, { error: 'Invalid or expired token' }));
    renderWithQuery(page());
    expect(await screen.findByRole('alert')).toHaveTextContent('common.loadError');
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  });

  it('Save is enabled once the stored settings have loaded', async () => {
    mockAuthedFetch.mockImplementation(() => json(200, stored));
    renderWithQuery(page());
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
