// ASY-33: staff see failed and maybe-sent messages and retry or cancel them.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { MessageOutbox } from '../MessageOutbox';

const mocks = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), permissions: ['message_outbox.view', 'message_outbox.manage'] as string[] }));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET, POST: mocks.POST } }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'support', permissions: mocks.permissions } }),
}));

const row = (over: Record<string, unknown>) => ({
  id: 1, client_id: 9, channel: 'email', recipient: 'ana@example.com', subject: 'Factura', source_type: 'invoice',
  status: 'failed', attempts: 5, max_attempts: 5, next_attempt_at: '2026-11-02T10:00:00Z', sent_at: null,
  last_error_code: 'EMAIL_DELIVERY_FAILED', last_error: 'Email delivery failed.', sensitive: 0, created_at: '2026-11-02T09:00:00Z',
  ...over,
});

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MessageOutbox />
  </QueryClientProvider>,
);

describe('MessageOutbox', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.permissions = ['message_outbox.view', 'message_outbox.manage'];
    mocks.GET.mockImplementation(async (path: string) => (path === '/message-outbox/summary'
      ? { data: { data: [{ status: 'failed', channel: 'email', count: 1 }, { status: 'outcome_unknown', channel: 'sms', count: 1 }] } }
      : { data: {
        data: [
          row({}),
          row({ id: 2, channel: 'sms', recipient: '+5215555555555', subject: null, status: 'outcome_unknown', attempts: 1, last_error: 'Maybe' }),
          row({ id: 3, recipient: 'staff@isp.mx', client_id: null, subject: 'Reset', status: 'failed', sensitive: 1 }),
        ],
        meta: { page: 1, limit: 50, total: 3, totalPages: 1 },
      } }));
    mocks.POST.mockResolvedValue({ error: undefined });
  });

  it('lists messages with their state and the counts needing attention', async () => {
    renderIt();
    expect(await screen.findByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${i18n.t('messageOutbox.status.failed')}: 1` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${i18n.t('messageOutbox.status.outcome_unknown')}: 1` })).toBeInTheDocument();
  });

  it('retries a failed message', async () => {
    renderIt();
    await screen.findByText('ana@example.com');
    await userEvent.click(screen.getAllByRole('button', { name: i18n.t('messageOutbox.retry') })[0]);
    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/message-outbox/{id}/retry', {
      params: { path: { id: 1 } }, body: { confirm_possible_duplicate: false },
    }));
  });

  it('asks before resending a message that may already have arrived', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderIt();
    await screen.findByText('+5215555555555');
    const retryMaybeSent = () => screen.getAllByRole('button', { name: i18n.t('messageOutbox.retry') })[1];

    await userEvent.click(retryMaybeSent());
    expect(mocks.POST).not.toHaveBeenCalled();

    await userEvent.click(retryMaybeSent());
    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/message-outbox/{id}/retry', {
      params: { path: { id: 2 } }, body: { confirm_possible_duplicate: true },
    }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('offers no retry for a message that carried a secret', async () => {
    renderIt();
    await screen.findByText('staff@isp.mx');
    // Rows 1 and 2 can be retried; the sensitive row 3 can only be cancelled.
    expect(screen.getAllByRole('button', { name: i18n.t('messageOutbox.retry') })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: i18n.t('messageOutbox.cancel') })).toHaveLength(3);
  });

  it('shows no actions to staff who can only view', async () => {
    mocks.permissions = ['message_outbox.view'];
    renderIt();
    await screen.findByText('ana@example.com');
    expect(screen.queryByRole('button', { name: i18n.t('messageOutbox.retry') })).toBeNull();
    expect(screen.queryByRole('button', { name: i18n.t('messageOutbox.cancel') })).toBeNull();
  });
});
