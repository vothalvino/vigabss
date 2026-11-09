// =============================================================================
// Reseller management: the list (/resellers) and one point's page (/resellers/:id)
// =============================================================================
// The list searches and filters; each row opens the point's page, whose tabs
// are the ones that apply to that point and work on it without a picker.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ResellerPage from '../ResellerPage';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  GET: vi.fn(),
  user: { id: 1, role: 'admin', organization_currency: 'MXN' } as { id: number; role: string; organization_currency: string; permissions?: string[] },
}));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET, PUT: vi.fn(), DELETE: vi.fn() } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));

const LUPITA = {
  id: 4, name: 'Tienda Lupita', kind: 'reseller', parent_id: null, parent_name: null, level: 1, status: 'active',
  commission_rate: '10.00', contact_name: 'Lupita Gómez', city: 'Toluca', phone: '5550001', email: 'lupita@example.com',
  address: 'Av. Juárez 10', notes: null, cash_on_hand: '300.00', effective_credit_limit: '2000.00', in_bags: '500.00', balance: '300.00',
};
const NORTE = { ...LUPITA, id: 7, name: 'Lupita Norte', parent_id: 4, parent_name: 'Tienda Lupita', level: 2, commission_rate: '0.00', cash_on_hand: undefined };
const COBROS = { ...LUPITA, id: 6, name: 'Cobros Centro', kind: 'collector', commission_rate: '0.00', collection_fee_type: 'fixed', collection_fee_value: '2.00', cash_on_hand: '1800.00', effective_credit_limit: '2000.00' };
const BY_ID: Record<number, unknown> = { 4: LUPITA, 6: COBROS, 7: NORTE };

function respond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (path.startsWith('/resellers?parent_id=4&')) return { data: [NORTE], meta: { total: 1, page: 1, limit: 100 } };
  if (path.startsWith('/resellers?')) {
    const q = new URLSearchParams(path.split('?')[1]);
    const rows = [LUPITA, NORTE, COBROS].filter(r => (!q.get('kind') || r.kind === q.get('kind'))
      && (!q.get('search') || r.name.toLowerCase().includes(String(q.get('search')).toLowerCase())));
    return { data: rows, meta: { total: rows.length, page: 1, limit: 25 } };
  }
  const one = path.match(/^\/resellers\/(\d+)$/);
  if (one && method === 'GET') {
    const r = BY_ID[Number(one[1])];
    if (!r) throw new Error('Reseller not found');
    return { data: r };
  }
  if (path === '/resellers' && method === 'POST') return { data: { id: 10 } };
  if (path.startsWith('/reseller-portal/4/dashboard')) return { data: { reseller_id: 4, subscriber_count: 12, total_revenue: 5400, open_tickets: 1, pending_commission: 540 } };
  if (path.startsWith('/resellers/4/bags?')) return { data: [], meta: { total: 0, page: 1, limit: 25 }, summary: { variance: '0.00' } };
  if (path.startsWith('/resellers/4/ledger?')) return { data: [], summary: { balance: '300.00', credit_limit: '2000.00', available_to_collect: '1700.00' }, meta: { total: 0 } };
  throw new Error(`unexpected request ${method} ${path}`);
}

function Where() {
  const loc = useLocation();
  return <output aria-label="location">{loc.pathname}{loc.search}</output>;
}

function renderAt(url: string, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/resellers" element={<ResellerPage />} />
          <Route path="/resellers/:id" element={<ResellerPage />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const location = () => screen.getByLabelText('location').textContent;
const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 1, role: 'admin', organization_currency: 'MXN' };
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => respond(path, init));
  mocks.GET.mockResolvedValue({ data: { data: [] }, error: undefined });
});

describe('the list', () => {
  it('shows each point with its type, status, cash against its limit and what it earns, and opens its page', async () => {
    renderAt('/resellers');
    const row = (await screen.findByRole('link', { name: 'Tienda Lupita' })).closest('tr')!;
    expect(within(row).getByText('Master')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('$300.00 of $2,000.00')).toBeInTheDocument();
    expect(within(row).getByText('10% commission')).toBeInTheDocument();
    const sub = screen.getByRole('link', { name: 'Lupita Norte' }).closest('tr')!;
    expect(within(sub).getByText('Sub-reseller of Tienda Lupita')).toBeInTheDocument();
    const collector = screen.getByRole('link', { name: 'Cobros Centro' }).closest('tr')!;
    expect(within(collector).getByText('$2.00 per payment')).toBeInTheDocument();
    // No "choose a reseller" anywhere.
    expect(screen.queryByLabelText('Reseller')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByText('Toluca', { exact: false }));
    expect(location()).toBe('/resellers/4');
    expect(await screen.findByRole('heading', { name: 'Tienda Lupita' })).toBeInTheDocument();
  });

  it('searches as the user types and filters by type', async () => {
    const user = userEvent.setup();
    renderAt('/resellers');
    await screen.findByRole('link', { name: 'Tienda Lupita' });
    await user.type(screen.getByLabelText('Search'), 'cobros');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers?page=1&limit=25&search=cobros'));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Tienda Lupita' })).not.toBeInTheDocument());
    await user.clear(screen.getByLabelText('Search'));
    await user.selectOptions(screen.getByLabelText('Type'), 'collector');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers?page=1&limit=25&kind=collector'));
  });

  it('says when nothing matches the filters', async () => {
    const user = userEvent.setup();
    renderAt('/resellers');
    await screen.findByRole('link', { name: 'Tienda Lupita' });
    await user.type(screen.getByLabelText('Search'), 'zzz');
    expect(await screen.findByText('No resellers or collectors match these filters.')).toBeInTheDocument();
  });

  it.each([
    ['a reseller user', ['resellers.view', 'reseller_portal.dashboard'], { edit: false, suspend: false, del: false, create: false }],
    ['suspend without delete', ['resellers.view', 'resellers.suspend'], { edit: false, suspend: true, del: false, create: false }],
    ['an admin', undefined, { edit: true, suspend: true, del: true, create: true }],
  ])('%s sees only the actions it may take', async (_who, permissions, expected) => {
    mocks.user = { ...mocks.user, role: permissions ? 'billing' : 'admin', permissions };
    renderAt('/resellers');
    const row = (await screen.findByRole('link', { name: 'Tienda Lupita' })).closest('tr')!;
    expect(Boolean(within(row).queryByRole('button', { name: 'Edit' }))).toBe(expected.edit);
    expect(Boolean(within(row).queryByRole('button', { name: 'Suspend' }))).toBe(expected.suspend);
    expect(Boolean(within(row).queryByRole('button', { name: 'Delete' }))).toBe(expected.del);
    expect(Boolean(screen.queryByRole('button', { name: 'New reseller' }))).toBe(expected.create);
  });

  it('creates a reseller and refreshes the cached reseller pickers', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const user = userEvent.setup();
    renderAt('/resellers', qc);
    await user.click(await screen.findByRole('button', { name: 'New reseller' }));
    expect(screen.getByRole('dialog', { name: 'New reseller' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), 'Punto Centro');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resellers-options'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resellers-top-level'] });
    });
  });
});

describe('one point\'s page', () => {
  it('a top-level reseller has every tab, its money in the header, and its summary', async () => {
    renderAt('/resellers/4');
    expect(await screen.findByRole('heading', { name: 'Tienda Lupita' })).toBeInTheDocument();
    expect(tabNames()).toEqual(['Summary', 'Movements', 'Bags', 'Commissions', 'Statements', 'Allowed plans', 'Staff access']);
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('$300.00 of $2,000.00')).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    const subs = screen.getByRole('region', { name: 'Sub-resellers' });
    expect(within(subs).getByRole('link', { name: 'Lupita Norte' })).toHaveAttribute('href', '/resellers/7');
    expect(screen.getByRole('link', { name: /All resellers/ })).toHaveAttribute('href', '/resellers');
  });

  it('a tab works on this point without a picker, and the URL keeps it', async () => {
    const user = userEvent.setup();
    renderAt('/resellers/4');
    await user.click(await screen.findByRole('tab', { name: 'Bags' }));
    expect(location()).toBe('/resellers/4?tab=bags');
    expect(await screen.findByText('This reseller has no bags yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Reseller')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign bags' })).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers/4/bags?page=1&limit=25');
  });

  it('opens on the tab the URL names', async () => {
    renderAt('/resellers/4?tab=ledger');
    expect(await screen.findByRole('tab', { name: 'Movements' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers/4/ledger?page=1&limit=25'));
  });

  it('a collector has no commissions or allowed plans', async () => {
    renderAt('/resellers/6');
    await screen.findByRole('heading', { name: 'Cobros Centro' });
    expect(tabNames()).toEqual(['Summary', 'Movements', 'Bags', 'Statements', 'Staff access']);
    expect(screen.getByText('Collector')).toBeInTheDocument();
    expect(screen.getByText('$2.00 per payment')).toBeInTheDocument();
  });

  it('a sub-reseller shows its parent, whose page holds its cash, bags and statements', async () => {
    renderAt('/resellers/7');
    await screen.findByRole('heading', { name: 'Lupita Norte' });
    expect(tabNames()).toEqual(['Summary', 'Staff access']);
    expect(screen.getByRole('link', { name: 'Tienda Lupita' })).toHaveAttribute('href', '/resellers/4');
    expect(screen.getByText(/collects and earns on Tienda Lupita's account/)).toBeInTheDocument();
  });

  it('shows only the tabs the user may see', async () => {
    mocks.user = { ...mocks.user, role: 'billing', permissions: ['resellers.view'] };
    renderAt('/resellers/4?tab=ledger');
    await screen.findByRole('heading', { name: 'Tienda Lupita' });
    expect(tabNames()).toEqual(['Summary', 'Allowed plans', 'Staff access']);
    // A tab the user may not see falls back to the summary.
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('says when the reseller does not exist', async () => {
    renderAt('/resellers/99');
    expect(await screen.findByRole('alert')).toHaveTextContent("This reseller doesn't exist, or you can't see it.");
  });
});
