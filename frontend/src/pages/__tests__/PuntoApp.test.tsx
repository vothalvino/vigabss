// =============================================================================
// Reseller app (/punto) — layout, Inicio, Clientes, client detail, Prospectos
// =============================================================================
// The app calls only /reseller-app/* (the server refuses staff endpoints to a
// reseller-bound account), so these tests stub apiFetch and fail on any other
// path.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';
import { PuntoLayout } from '../punto/PuntoLayout';
import { PuntoHome } from '../punto/PuntoHome';
import { PuntoClients } from '../punto/PuntoClients';
import { PuntoClientDetail } from '../punto/PuntoClientDetail';
import { PuntoLeads } from '../punto/PuntoLeads';

const RESELLER_USER = {
  id: 7, role: 'billing', organization_currency: 'MXN',
  permissions: ['reseller_app.use', 'reseller_app.signup', 'reseller_app.collect'],
  reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' },
};

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  logout: vi.fn(async () => {}),
  user: null as unknown,
}));

vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, logout: mocks.logout }),
}));

const ME = {
  reseller: { id: 4, name: 'Punto Norte', level: 1, status: 'active', commission_rate: '10.00', parent_id: null },
  currency: 'MXN',
  counts: { active_clients: 12, suspended_clients: 3, open_leads: 5, overdue_clients: 2 },
};

const CLIENTS = [
  { id: 31, name: 'Ana López', phone: '5512345678', email: null, status: 'active', reseller_id: 4, balance_due: '0.00', overdue: false },
  { id: 32, name: 'Beto Ruiz', phone: null, email: 'beto@example.com', status: 'suspended', reseller_id: 4, balance_due: '450.00', overdue: true },
];

const CLIENT_31 = {
  id: 31, name: 'Ana López', phone: '5512345678', email: 'ana@example.com', address: 'Calle 1 #2', status: 'active',
  reseller_id: 4, balance_due: '350.00',
  contracts: [{ id: 5, status: 'active', plan_name: 'Fibra 50', monthly_price: '350.00' }],
  invoices: [{ id: 9, invoice_number: 'F-0009', status: 'overdue', total: '350.00', balance: '350.00', due_date: '2026-10-05', issue_date: '2026-09-28' }],
};

function respond(path: string): unknown {
  if (path === '/reseller-app/me') return { data: ME };
  if (path.startsWith('/reseller-app/clients?')) return { data: CLIENTS, meta: { total: 2, page: 1, limit: 20 } };
  if (path === '/reseller-app/clients/31') return { data: CLIENT_31 };
  if (path.startsWith('/reseller-app/leads?')) {
    return {
      data: [
        { id: 70, name: 'Carla Díaz', phone: '5511112222', status: 'new', desired_plan_id: 3, desired_plan_name: 'Fibra 100', created_at: '2026-10-20T15:00:00Z', converted_client_id: null },
        { id: 71, name: 'Ana López', phone: '5512345678', status: 'won', desired_plan_id: null, desired_plan_name: null, created_at: '2026-09-01T15:00:00Z', converted_client_id: 31 },
      ],
      meta: { total: 2, page: 1, limit: 20 },
    };
  }
  throw new Error(`unexpected request ${path}`);
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<PuntoLayout />}>
            <Route path="/punto" element={<PuntoHome />} />
            <Route path="/punto/clientes" element={<PuntoClients />} />
            <Route path="/punto/clientes/:id" element={<PuntoClientDetail />} />
            <Route path="/punto/nuevo" element={<p>new client form</p>} />
            <Route path="/punto/prospectos" element={<PuntoLeads />} />
          </Route>
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  mocks.user = RESELLER_USER;
  mocks.apiFetch.mockImplementation(async (path: string) => respond(path));
});
afterEach(async () => { await i18n.changeLanguage('en'); });

describe('PuntoLayout', () => {
  it('shows the reseller name and the five tabs, and no staff navigation', async () => {
    renderAt('/punto');
    expect(screen.getByText('Punto Norte')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    const links = within(nav).getAllByRole('link');
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/punto', '/punto/cobrar', '/punto/clientes', '/punto/nuevo', '/punto/caja']);
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveClass('active');
    await screen.findByText('12');
    // Only reseller-app endpoints were called.
    for (const [path] of mocks.apiFetch.mock.calls) expect(path).toMatch(/^\/reseller-app\//);
  });

  it('labels the tabs in Spanish', async () => {
    await i18n.changeLanguage('es');
    renderAt('/punto');
    const nav = screen.getByRole('navigation', { name: 'Menú principal' });
    expect(within(nav).getAllByRole('link').map(l => l.textContent)).toEqual(['Inicio', 'Cobrar', 'Clientes', 'Nuevo', 'Mi caja']);
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('gives a long reseller name its own header row, apart from the language picker', () => {
    mocks.user = { ...RESELLER_USER, reseller_binding: { reseller_id: 4, reseller_name: 'Abarrotes y Papelería La Esperanza de San Juan' } };
    renderAt('/punto');
    const name = screen.getByText('Abarrotes y Papelería La Esperanza de San Juan');
    const language = screen.getByRole('combobox', { name: 'Language' });
    // The name shares its row only with "Sign out"; the picker is on the next row.
    expect(name.closest('.punto-header-row')).toContainElement(screen.getByRole('button', { name: 'Sign out' }));
    expect(name.closest('.punto-header-row')).not.toContainElement(language);
    expect(language.closest('.punto-header-row')).not.toBeNull();
  });

  it('hides the sign-up and collect tabs without reseller_app.signup and reseller_app.collect', async () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use'] };
    renderAt('/punto');
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    expect(within(nav).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/punto', '/punto/clientes', '/punto/caja']);
    await screen.findByText('12');
    expect(screen.queryByRole('link', { name: 'New client' })).not.toBeInTheDocument();
  });

  it('explains a missing reseller_app.use instead of failing every request', async () => {
    mocks.user = { ...RESELLER_USER, permissions: [] };
    renderAt('/punto/clientes');
    expect(screen.getByRole('alert')).toHaveTextContent('No access to the point of sale app');
    expect(screen.queryByRole('navigation', { name: 'Main menu' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('signs out and goes to the sign-in page', async () => {
    renderAt('/punto');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('login page')).toBeInTheDocument();
  });
});

describe('PuntoHome (Inicio)', () => {
  it('shows the counts from /reseller-app/me and the new-client button', async () => {
    renderAt('/punto');
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('12').closest('a')).toHaveTextContent('Active clients');
    expect(within(summary).getByText('3').closest('a')).toHaveTextContent('Suspended clients');
    expect(within(summary).getByText('2').closest('a')).toHaveTextContent('Clients with overdue invoices');
    expect(within(summary).getByText('2').closest('a')).toHaveAttribute('href', '/punto/clientes?overdue=1');
    expect(within(summary).getByText('5').closest('a')).toHaveTextContent('Open prospects');
    expect(screen.getAllByRole('link', { name: 'New client' }).some(a => a.getAttribute('href') === '/punto/nuevo')).toBe(true);
    // Without the money block in /me there is no cash card.
    expect(screen.queryByRole('region', { name: 'Your cash' })).not.toBeInTheDocument();
  });

  it('reports a load failure', async () => {
    mocks.apiFetch.mockRejectedValue(new Error('boom'));
    renderAt('/punto');
    expect(await screen.findByText('Your summary could not be loaded.')).toBeInTheDocument();
  });
});

describe('PuntoClients (Clientes)', () => {
  it('lists the clients with status, balance and the overdue badge', async () => {
    renderAt('/punto/clientes');
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    const beto = screen.getByText('Beto Ruiz').closest('a')!;
    expect(beto).toHaveAttribute('href', '/punto/clientes/32');
    expect(within(beto).getByText('Suspended')).toBeInTheDocument();
    expect(within(beto).getByText('Overdue')).toBeInTheDocument();
    expect(beto.textContent).toMatch(/450\.00/);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients?page=1&limit=20');
    // Prospects are no longer a tab: Clientes links to them.
    expect(screen.getByRole('link', { name: 'Prospects' })).toHaveAttribute('href', '/punto/prospectos');
  });

  it('searches and filters by status', async () => {
    renderAt('/punto/clientes?status=suspended');
    await screen.findByText('Ana López');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients?page=1&limit=20&status=suspended');
    await userEvent.type(screen.getByLabelText('Search'), 'beto');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients?page=1&limit=20&search=beto&status=suspended'));
  });

  it('lists only overdue clients when opened from the overdue card, and can show all again', async () => {
    renderAt('/punto/clientes?overdue=1');
    await screen.findByText('Ana López');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients?page=1&limit=20&overdue=1');
    expect(screen.getByText('Overdue only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients?page=1&limit=20'));
    expect(screen.queryByText('Overdue only')).not.toBeInTheDocument();
  });

  it('opens a client with its services and invoices', async () => {
    renderAt('/punto/clientes');
    await userEvent.click(await screen.findByText('Ana López'));
    expect(await screen.findByRole('heading', { name: 'Ana López' })).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/clients/31');
    const services = screen.getByRole('region', { name: 'Services' });
    expect(within(services).getByText('Fibra 50')).toBeInTheDocument();
    const invoices = screen.getByRole('region', { name: 'Recent invoices' });
    expect(within(invoices).getByText('F-0009')).toBeInTheDocument();
    expect(within(invoices).getByText('Overdue')).toBeInTheDocument();
    // A DATE column renders on its calendar day in Mexico City.
    expect(within(invoices).getByText(/Due 5 oct/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Collect a payment' })).toHaveAttribute('href', '/punto/cobrar?cliente=31');
  });

  it('offers no collect button without reseller_app.collect', async () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use'] };
    renderAt('/punto/clientes/31');
    expect(await screen.findByRole('heading', { name: 'Ana López' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Collect a payment' })).not.toBeInTheDocument();
  });

  it('says so when the client is not in the reseller subtree', async () => {
    const { ApiRequestError } = await import('@/api/apiFetch');
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/reseller-app/clients/99') throw new ApiRequestError('Not found', 404);
      return respond(path);
    });
    renderAt('/punto/clientes/99');
    expect(await screen.findByText('This client is not one of yours or no longer exists.')).toBeInTheDocument();
  });
});

describe('PuntoLeads (Prospectos)', () => {
  it('lists the sign-ups with status and desired plan', async () => {
    renderAt('/punto/prospectos');
    const carla = (await screen.findByText('Carla Díaz')).closest('li')!;
    expect(within(carla).getByText('New')).toBeInTheDocument();
    expect(within(carla).getByText('Plan: Fibra 100')).toBeInTheDocument();
    const ana = screen.getByText('Ana López').closest('li')!;
    expect(within(ana).getByText('Won')).toBeInTheDocument();
    expect(within(ana).getByRole('link', { name: 'View client' })).toHaveAttribute('href', '/punto/clientes/31');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/leads?page=1&limit=20');
  });
});
