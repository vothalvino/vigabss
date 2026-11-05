// =============================================================================
// VigaBSS 5.0 — Payment problems page tests
// =============================================================================
// The API listed failed webhook events, succeeded charges with no payment and
// refunds a live REP still reports (BIL-32), but no screen showed them.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { PaymentProblems } from '../PaymentProblems';
import { ROUTES } from '@/nav/routes';

const mocks = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET } }));

const page = <T,>(data: T[]) => ({ data: { data, meta: { total: data.length, page: 1, limit: 50, totalPages: 1 } }, error: undefined });
const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PaymentProblems />
  </QueryClientProvider>,
);

describe('PaymentProblems', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.GET.mockImplementation((path: string) => {
      if (path === '/payment-gateways/webhook-events') {
        return Promise.resolve(page([{
          id: 1, provider: 'stripe', provider_event_id: 'evt_1', event_type: 'charge.refunded', status: 'failed',
          error_message: 'Refund reversal failed', transaction_id: 7, created_at: '2026-11-05T10:00:00Z',
        }]));
      }
      if (path === '/payment-gateways/unsettled-transactions') {
        return Promise.resolve(page([{
          id: 9, client_id: 3, invoice_id: 12, gateway_reference_id: 'pi_9', amount: '499.00', currency: 'MXN', created_at: '2026-11-05T10:00:00Z',
        }]));
      }
      if (path === '/payment-gateways/refunded-with-live-rep') {
        return Promise.resolve(page([{
          payment_id: 40, client_id: 3, amount: '1160.00', currency: 'MXN', reference_number: 'TXN-40',
          rep_id: 31, rep_uuid: 'AAAA-REP', rep_sat_status: 'vigente',
        }]));
      }
      return Promise.resolve(page([]));
    });
  });

  it('opens on the failed webhook events', async () => {
    renderIt();
    expect(await screen.findByText('Refund reversal failed')).toBeInTheDocument();
    expect(mocks.GET).toHaveBeenCalledWith('/payment-gateways/webhook-events', { params: { query: { page: 1, limit: 50, status: 'failed' } } });
  });

  it('can list every webhook event', async () => {
    renderIt();
    await screen.findByText('Refund reversal failed');
    await userEvent.selectOptions(screen.getByLabelText(t('paymentProblems.status')), '');
    await waitFor(() => expect(mocks.GET).toHaveBeenCalledWith('/payment-gateways/webhook-events', { params: { query: { page: 1, limit: 50 } } }));
  });

  it('shows the charges with no payment posted', async () => {
    renderIt();
    await userEvent.click(screen.getByRole('tab', { name: t('paymentProblems.tab.unsettled') }));
    expect(await screen.findByText('pi_9')).toBeInTheDocument();
    expect(screen.getByText(t('paymentProblems.unsettledHelp'))).toBeInTheDocument();
  });

  it('shows the refunds a live REP still reports, with the REP to cancel', async () => {
    renderIt();
    await userEvent.click(screen.getByRole('tab', { name: t('paymentProblems.tab.refunds') }));
    expect(await screen.findByText('AAAA-REP')).toBeInTheDocument();
    expect(screen.getByText('vigente')).toBeInTheDocument();
    expect(screen.getByText(/motivo 02/)).toBeInTheDocument();
  });

  it('says so when a list is empty', async () => {
    mocks.GET.mockImplementation(() => Promise.resolve(page([])));
    renderIt();
    expect(await screen.findByText(t('paymentProblems.noWebhooks'))).toBeInTheDocument();
  });

  it('is in the billing navigation behind payment_gateways.view', () => {
    const route = ROUTES.find(r => r.path === '/payment-problems');
    expect(route).toMatchObject({ section: 'billing', viewPermissions: ['payment_gateways.view'] });
  });
});
