// =============================================================================
// VigaBSS 5.0 — Reseller staff access tab tests
// =============================================================================
// The API bound and unbound staff users to a reseller (TNB-13), but no screen
// did. The tab lists a reseller's bound users, binds one after a warning, and
// removes a binding; without resellers.update and users.update it is
// read-only.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { ResellerUserBindingsTab } from '../ResellerUserBindingsTab';

const mocks = vi.hoisted(() => ({
  GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(),
  permissions: ['resellers.view', 'resellers.update', 'users.update'] as string[],
}));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET, PUT: mocks.PUT, DELETE: mocks.DELETE } }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'manager', permissions: mocks.permissions } }),
}));

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);
const ok = (data: unknown) => Promise.resolve({ data: { data }, error: undefined });

const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ResellerUserBindingsTab />
  </QueryClientProvider>,
);

async function chooseReseller() {
  renderIt();
  await screen.findByRole('option', { name: 'Norte Fibra' });
  await userEvent.selectOptions(screen.getByLabelText(t('resellerAccess.reseller')), '4');
}

describe('ResellerUserBindingsTab', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.permissions = ['resellers.view', 'resellers.update', 'users.update'];
    mocks.GET.mockImplementation((path: string) => {
      if (path === '/resellers') return ok([{ id: 4, name: 'Norte Fibra' }]);
      if (path === '/resellers/{id}/users') {
        return ok([{ id: 9, user_id: 20, reseller_id: 4, first_name: 'Ana', last_name: 'Ruiz', email: 'ana@norte.mx', user_status: 'active', created_at: '2026-10-01T00:00:00Z' }]);
      }
      if (path === '/users') {
        return ok([
          { id: 1, first_name: 'Me', last_name: null, email: 'me@isp.mx' },
          { id: 20, first_name: 'Ana', last_name: 'Ruiz', email: 'ana@norte.mx' },
          { id: 21, first_name: 'Beto', last_name: 'Paz', email: 'beto@norte.mx' },
        ]);
      }
      return ok([]);
    });
    mocks.PUT.mockResolvedValue({ data: { data: {} }, error: undefined });
    mocks.DELETE.mockResolvedValue({ data: { data: {} }, error: undefined });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('lists the users bound to the chosen reseller', async () => {
    await chooseReseller();
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(mocks.GET).toHaveBeenCalledWith('/resellers/{id}/users', { params: { path: { id: 4 } } });
  });

  it('offers only users not yet bound, and never the caller', async () => {
    await chooseReseller();
    await screen.findByText('Ana Ruiz');
    const picker = screen.getByLabelText(t('resellerAccess.addUser'));
    const options = within(picker).getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual([t('resellerAccess.selectUser'), 'Beto Paz · beto@norte.mx']);
  });

  it('binds a user after the warning', async () => {
    await chooseReseller();
    await screen.findByText('Ana Ruiz');
    await userEvent.selectOptions(screen.getByLabelText(t('resellerAccess.addUser')), '21');
    await userEvent.click(screen.getByRole('button', { name: t('resellerAccess.bind') }));
    expect(window.confirm).toHaveBeenCalledWith(t('resellerAccess.confirmBind'));
    await waitFor(() => expect(mocks.PUT).toHaveBeenCalledWith('/resellers/{id}/users/{userId}', { params: { path: { id: 4, userId: 21 } } }));
  });

  it('removes a binding', async () => {
    await chooseReseller();
    const row = (await screen.findByText('Ana Ruiz')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: t('resellerAccess.unbind') }));
    await waitFor(() => expect(mocks.DELETE).toHaveBeenCalledWith('/resellers/{id}/users/{userId}', { params: { path: { id: 4, userId: 20 } } }));
  });

  it('shows the server\'s reason when a bind is refused', async () => {
    mocks.PUT.mockResolvedValue({ data: undefined, error: { error: { message: 'Reseller-bound users cannot manage reseller bindings' } } });
    await chooseReseller();
    await screen.findByText('Ana Ruiz');
    await userEvent.selectOptions(screen.getByLabelText(t('resellerAccess.addUser')), '21');
    await userEvent.click(screen.getByRole('button', { name: t('resellerAccess.bind') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reseller-bound users cannot manage reseller bindings');
  });

  it('is read-only without resellers.update and users.update', async () => {
    mocks.permissions = ['resellers.view'];
    await chooseReseller();
    expect(await screen.findByText('Ana Ruiz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('resellerAccess.unbind') })).toBeNull();
    expect(screen.queryByLabelText(t('resellerAccess.addUser'))).toBeNull();
    expect(mocks.GET).not.toHaveBeenCalledWith('/users', expect.anything());
  });
});
