// SUP-04: staff had no way to see or end a client's WhatsApp bindings, so a
// lost or recycled number kept reading the account.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { ClientWhatsappLinks } from '../ClientWhatsappLinks';

const mocks = vi.hoisted(() => ({ GET: vi.fn(), DELETE: vi.fn(), permissions: ['clients.view', 'clients.update'] as string[] }));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET, DELETE: mocks.DELETE } }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'support', permissions: mocks.permissions } }),
}));

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ClientWhatsappLinks clientId={10} />
  </QueryClientProvider>,
);

describe('ClientWhatsappLinks', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.permissions = ['clients.view', 'clients.update'];
    mocks.GET.mockResolvedValue({ data: { data: [
      { id: 31, phone_e164: '+525599998888', bound_via: 'portal', bound_at: '2026-10-01T10:00:00Z', last_seen_at: null },
    ] } });
    mocks.DELETE.mockResolvedValue({ error: undefined });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lists the bound numbers and unlinks one', async () => {
    renderIt();
    expect(await screen.findByText('+525599998888')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: i18n.t('clientWhatsapp.revoke') }));
    await waitFor(() => expect(mocks.DELETE).toHaveBeenCalledWith('/clients/{id}/whatsapp-links/{linkId}', {
      params: { path: { id: 10, linkId: 31 } },
    }));
  });

  it('hides Unlink from staff who cannot edit clients', async () => {
    mocks.permissions = ['clients.view'];
    renderIt();
    expect(await screen.findByText('+525599998888')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('clientWhatsapp.revoke') })).toBeNull();
  });
});
