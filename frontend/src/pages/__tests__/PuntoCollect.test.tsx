// =============================================================================
// Reseller app (/punto), phase 2 — Inicio money card, Cobrar, receipt, Mi caja
// =============================================================================
// Like PuntoApp.test.tsx these stub apiFetch and fail on any path outside
// /reseller-app: a reseller-bound account may not call staff endpoints.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureAxe } from 'jest-axe';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import { PuntoLayout } from '../punto/PuntoLayout';
import { PuntoHome } from '../punto/PuntoHome';
import { PuntoCollect } from '../punto/PuntoCollect';
import { PuntoReceipt } from '../punto/PuntoReceipt';
import { PuntoCash } from '../punto/PuntoCash';

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

const MONEY = {
  currency: 'MXN', balance: '800.00', cash_on_hand: '800.00', credit_limit: '2000.00',
  available_to_collect: '1200.00', collected_today: '350.00',
};
let money: typeof MONEY & { commission_rate?: number; commission_month?: number } = MONEY;
const me = () => ({
  data: {
    reseller: { id: 4, name: 'Punto Norte', level: 1, status: 'active', commission_rate: '10.00', parent_id: null },
    currency: 'MXN',
    counts: { active_clients: 12, suspended_clients: 3, open_leads: 5, overdue_clients: 2 },
    money,
  },
});

const OWN = {
  collect_token: 'tok-own', own: true, client_number: 31, name: 'Ana López', status: 'active', amount_due: '700.00',
  // Newest first on purpose: the page lists them oldest first.
  open_invoices: [
    { id: 10, invoice_number: 'F-0010', balance: '350.00', due_date: '2026-11-05' },
    { id: 9, invoice_number: 'F-0009', balance: '350.00', due_date: '2026-10-05' },
  ],
};
const OTHER = {
  collect_token: 'tok-other', own: false, client_number: 58, name: 'Ma*** Ló***', status: 'suspended', amount_due: '500.00',
  open_invoices: [{ id: 20, invoice_number: 'F-0020', balance: '500.00', due_date: '2026-10-20' }],
};

const RECEIPT = {
  receipt_number: 'RC-000101', issued_at: '2026-11-07T16:05:00Z',
  isp: { name: 'Fibra Ejemplo SA de CV', rfc: 'FEJ010101AB1', address: 'Av. Siempre Viva 1', phone: '5550001111' },
  collected_by: { reseller_name: 'Punto Norte', user_name: 'Lupita' },
  client: { number: 31, name: 'Ana López' },
  amount: '350.00', currency: 'MXN', payment_method: 'cash',
  allocations: [{ invoice_number: 'F-0009', amount: '350.00' }],
  remaining_balance: '350.00',
  legend: 'Cobrado por Punto Norte a nombre de Fibra Ejemplo SA de CV. El pago queda registrado con Fibra Ejemplo SA de CV.',
};

const SESSION = {
  current: { id: 5, opened_at: '2026-11-07T15:00:00Z', expected_total: '700.00', collections_count: 2 },
  recent: [{ id: 4, opened_at: '2026-11-06T15:00:00Z', closed_at: '2026-11-06T23:00:00Z', expected_total: '1000.00', counted_total: '990.00', variance: '-10.00', status: 'closed' }],
};
const COLLECTIONS = [
  { id: 101, client_number: 31, client_name: 'Ana López', own: true, amount: '350.00', collected_at: '2026-11-07T16:05:00Z', status: 'completed', invoice_numbers: ['F-0009'], cash_session_id: 5 },
  { id: 100, client_number: 58, client_name: 'Ma*** Ló***', own: false, amount: '200.00', collected_at: '2026-11-07T15:10:00Z', status: 'voided', invoice_numbers: ['F-0020'], cash_session_id: 5 },
];
const LEDGER = {
  data: [
    { id: 3, entry_type: 'deposit', amount: '-500.00', note: 'Entrega del lunes', created_at: '2026-11-06T18:00:00Z', payment_id: null },
    { id: 2, entry_type: 'collection', amount: '350.00', note: null, created_at: '2026-11-07T16:05:00Z', payment_id: 101 },
  ],
  summary: { balance: '800.00', cash_on_hand: '800.00', credit_limit: '2000.00', available_to_collect: '1200.00' },
  meta: { total: 2, page: 1, limit: 20 },
};

const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } }, runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });

type Handler = (path: string, init?: RequestInit) => unknown;
let override: Handler | null = null;

function respond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (override) {
    const r = override(path, init);
    if (r !== undefined) return r;
  }
  if (path === '/reseller-app/me') return me();
  if (path.startsWith('/reseller-app/collect/lookup?q=')) {
    const q = decodeURIComponent(path.split('q=')[1]);
    if (q === '5512345678') return { data: [OWN] };
    if (q === '#58') return { data: [OTHER] };
    return { data: [] };
  }
  if (path === '/reseller-app/collect/client/31') return { data: OWN };
  if (path === '/reseller-app/payments' && method === 'POST') {
    return { data: { payment_id: 101, amount: '350.00', allocated: [{ invoice_id: 9, amount: '350.00' }], client_number: 31, client_name: 'Ana López', reconnected: true, receipt_url: '/reseller-app/payments/101/receipt' } };
  }
  if (path === '/reseller-app/payments/101/receipt') return { data: RECEIPT };
  if (path.startsWith('/reseller-app/payments?')) return { data: COLLECTIONS, meta: { total: 2, page: 1, limit: 20 } };
  if (path === '/reseller-app/payments/101/void' && method === 'POST') return { data: { id: 101, status: 'voided' } };
  if (path === '/reseller-app/cash-session') return { data: SESSION };
  if (path === '/reseller-app/cash-session/close' && method === 'POST') {
    return { data: { id: 5, opened_at: SESSION.current.opened_at, closed_at: '2026-11-07T23:00:00Z', expected_total: '700.00', counted_total: '690.00', variance: '-10.00', status: 'closed' } };
  }
  if (path.startsWith('/reseller-app/ledger?')) return LEDGER;
  throw new Error(`unexpected request ${method} ${path}`);
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<PuntoLayout />}>
            <Route path="/punto" element={<PuntoHome />} />
            <Route path="/punto/cobrar" element={<PuntoCollect />} />
            <Route path="/punto/recibo/:id" element={<PuntoReceipt />} />
            <Route path="/punto/caja" element={<PuntoCash />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const calls = (method: string, path: string) =>
  mocks.apiFetch.mock.calls.filter(([p, init]) => p === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const headerOf = (call: unknown[], name: string) => new Headers((call[1] as RequestInit).headers).get(name);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  mocks.user = RESELLER_USER;
  money = MONEY;
  override = null;
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => respond(path, init));
});
afterEach(async () => { await i18n.changeLanguage('en'); });

describe('Inicio money card', () => {
  it('shows what the reseller owes, what it may still collect against its limit, and today', async () => {
    renderAt('/punto');
    const card = await screen.findByRole('region', { name: 'Your cash' });
    expect(within(card).getByText('You must hand in').parentElement).toHaveTextContent('$800.00');
    expect(within(card).getByText('Before your limit').parentElement).toHaveTextContent('$1,200.00');
    expect(within(card).getByText('Collected today').parentElement).toHaveTextContent('$350.00');
    const meter = within(card).getByRole('progressbar', { name: 'Cash limit in use' });
    expect(meter).toHaveAttribute('aria-valuenow', '40');
    expect(within(card).getByText('Your cash limit: $2,000.00')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Collect a payment' })).toHaveAttribute('href', '/punto/cobrar');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    // The phase-1 counts are still there.
    expect(screen.getByRole('region', { name: 'Summary' })).toHaveTextContent('12');
  });

  it('warns at the limit and offers no collect button', async () => {
    money = { ...MONEY, balance: '2000.00', cash_on_hand: '2000.00', available_to_collect: '0.00' };
    await i18n.changeLanguage('es');
    renderAt('/punto');
    const card = await screen.findByRole('region', { name: 'Tu efectivo' });
    expect(within(card).getByRole('alert')).toHaveTextContent('Llegaste a tu límite: entrega el efectivo para seguir cobrando.');
    expect(within(card).getByText('Debes entregar').parentElement).toHaveTextContent('$2,000.00');
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(within(card).queryByRole('link', { name: 'Cobrar' })).not.toBeInTheDocument();
  });
});

describe('Inicio commission (phase 4)', () => {
  it('shows the commission earned this month at the top-level rate', async () => {
    money = { ...MONEY, commission_rate: 7.5, commission_month: 38.79 };
    renderAt('/punto');
    const card = await screen.findByRole('region', { name: 'Your commission' });
    expect(within(card).getByText('Earned this month').parentElement).toHaveTextContent('$38.79');
    expect(card).toHaveTextContent('You earn 7.5% of each paid invoice of your clients, before taxes.');
  });

  it('shows nothing for a reseller that earns no commission, or an older server', async () => {
    money = { ...MONEY, commission_rate: 0, commission_month: 0 };
    const { unmount } = renderAt('/punto');
    await screen.findByRole('region', { name: 'Your cash' });
    expect(screen.queryByRole('region', { name: 'Your commission' })).not.toBeInTheDocument();
    unmount();
    money = MONEY;
    renderAt('/punto');
    await screen.findByRole('region', { name: 'Your cash' });
    expect(screen.queryByRole('region', { name: 'Your commission' })).not.toBeInTheDocument();
  });

  it('says "Te debemos" when the commissions passed the cash the reseller holds', async () => {
    money = { ...MONEY, balance: '-45.50', cash_on_hand: '-45.50', available_to_collect: '2045.50', commission_rate: 10, commission_month: 80 };
    await i18n.changeLanguage('es');
    renderAt('/punto');
    const card = await screen.findByRole('region', { name: 'Tu efectivo' });
    expect(within(card).getByText('Te debemos').parentElement).toHaveTextContent('$45.50');
    expect(within(card).queryByText('Debes entregar')).not.toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('region', { name: 'Tu comisión' })).toHaveTextContent('$80.00');
  });
});

describe('Cobrar', () => {
  it('finds a client, collects part of the debt and opens the receipt', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const user = userEvent.setup();
    renderAt('/punto/cobrar');
    await user.type(screen.getByLabelText('Customer number or phone'), '5512345678');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/collect/lookup?q=5512345678');

    const results = await screen.findByRole('region', { name: 'Results' });
    expect(within(results).getByText('Your client')).toBeInTheDocument();
    await user.click(within(results).getByRole('button', { name: /Ana López/ }));

    // Oldest first, all selected, the amount is their balance.
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map(b => b.closest('label')?.textContent)).toEqual([expect.stringContaining('F-0009'), expect.stringContaining('F-0010')]);
    expect(boxes.every(b => (b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByLabelText('Amount received')).toHaveValue('700.00');

    await user.click(screen.getByRole('checkbox', { name: /F-0010/ }));
    expect(screen.getByLabelText('Amount received')).toHaveValue('350.00');
    await user.click(screen.getByRole('button', { name: 'Collect $350.00 in cash' }));

    expect(screen.getByRole('heading', { name: 'Did you receive the cash?' })).toBeInTheDocument();
    expect(calls('POST', '/reseller-app/payments')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Yes, I received $350.00' }));

    expect(await screen.findByText('Payment of $350.00 recorded.')).toBeInTheDocument();
    const [post] = calls('POST', '/reseller-app/payments');
    expect(bodyOf(post)).toEqual({ collect_token: 'tok-own', amount: 350, invoice_ids: [9] });
    expect(headerOf(post, 'Idempotency-Key')).toBeTruthy();
    expect(screen.getByText("The client's service was reconnected.")).toBeInTheDocument();

    const receipt = screen.getByRole('article', { name: 'Payment receipt' });
    expect(within(receipt).getByText('Fibra Ejemplo SA de CV')).toBeInTheDocument();
    expect(within(receipt).getByText('RC-000101')).toBeInTheDocument();
    expect(within(receipt).getByText(RECEIPT.legend)).toBeInTheDocument();
    expect(within(receipt).getByText('Balance left').parentElement).toHaveTextContent('$350.00');

    const wa = screen.getByRole('link', { name: 'Send by WhatsApp' });
    expect(wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(wa.getAttribute('href')!.split('text=')[1])).toContain('Paid in cash: $350.00');
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'New collection' })).toHaveAttribute('href', '/punto/cobrar');
    for (const [path] of mocks.apiFetch.mock.calls) expect(path).toMatch(/^\/reseller-app\//);
  });

  it('retries one attempt with the same Idempotency-Key', async () => {
    let failures = 1;
    override = (path, init) => {
      if (path === '/reseller-app/payments' && init?.method === 'POST' && failures-- > 0) throw new TypeError('Failed to fetch');
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $700.00 in cash' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I received $700.00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('it will not be charged twice');
    await user.click(screen.getByRole('button', { name: 'Yes, I received $700.00' }));
    await screen.findByText('Payment of $350.00 recorded.');
    const posts = calls('POST', '/reseller-app/payments');
    expect(posts).toHaveLength(2);
    expect(headerOf(posts[0], 'Idempotency-Key')).toBe(headerOf(posts[1], 'Idempotency-Key'));
    // Every invoice selected is the server's default allocation.
    expect(bodyOf(posts[0])).toEqual({ collect_token: 'tok-own', amount: 700 });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/collect/client/31');
  });

  it('shows the cash-limit refusal: fill a bag or hand in the cash', async () => {
    override = (path, init) => {
      if (path === '/reseller-app/payments' && init?.method === 'POST') {
        throw new ApiRequestError('Credit limit reached', 409, { error: { code: 'CREDIT_LIMIT', message: 'Credit limit reached', available_to_collect: '150.00' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $700.00 in cash' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I received $700.00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You reached your cash limit: fill a bag (or hand in the cash) to keep collecting.');
  });

  it('lets a payment cross the limit: only a reseller already at it is stopped', async () => {
    money = { ...MONEY, cash_on_hand: '1900.00', balance: '1900.00', available_to_collect: '100.00' };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $700.00 in cash' }));
    expect(screen.getByRole('heading', { name: 'Did you receive the cash?' })).toBeInTheDocument();
  });

  it('does not send a collection once the known limit is reached', async () => {
    money = { ...MONEY, cash_on_hand: '2000.00', balance: '2000.00', available_to_collect: '0.00' };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $700.00 in cash' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You reached your cash limit');
    expect(screen.queryByRole('heading', { name: 'Did you receive the cash?' })).not.toBeInTheDocument();
  });

  it('shows a subscriber of someone else with a masked name and no contact data', async () => {
    const user = userEvent.setup();
    renderAt('/punto/cobrar');
    await user.type(screen.getByLabelText('Customer number or phone'), '#58');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/collect/lookup?q=%2358');
    const results = await screen.findByRole('region', { name: 'Results' });
    const item = within(results).getByRole('button', { name: /Ma\*\*\* Ló\*\*\*/ });
    expect(within(item).getByText('Company client')).toBeInTheDocument();
    expect(within(item).queryByText('Your client')).not.toBeInTheDocument();
    expect(within(item).getByText('Client #58')).toBeInTheDocument();
    expect(item).not.toHaveTextContent(/@|\d{10}/);
  });

  it('asks a collector for the customer number only, with no ownership chip', async () => {
    mocks.user = { ...(mocks.user as object), permissions: ['reseller_app.cash', 'reseller_app.collect', 'reseller_app.bags'] };
    const user = userEvent.setup();
    renderAt('/punto/cobrar');
    expect(screen.queryByLabelText('Customer number or phone')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type the customer number.');
    await user.type(screen.getByLabelText('Customer number'), '#58');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const results = await screen.findByRole('region', { name: 'Results' });
    const item = within(results).getByRole('button', { name: /Ma\*\*\* Ló\*\*\*/ });
    expect(within(item).queryByText('Company client')).not.toBeInTheDocument();
  });

  it('says so when nobody matches, and refuses an empty search', async () => {
    const user = userEvent.setup();
    renderAt('/punto/cobrar');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type a customer number or a phone number.');
    await user.type(screen.getByLabelText('Customer number or phone'), '999');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nobody has that number/)).toBeInTheDocument();
  });

  it('asks for a new search when the collect token expired', async () => {
    override = (path, init) => {
      if (path === '/reseller-app/payments' && init?.method === 'POST') {
        throw new ApiRequestError('This collection expired; look the customer up again.', 422, { error: { code: 'COLLECT_TOKEN_EXPIRED', message: 'This collection expired; look the customer up again.' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $700.00 in cash' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I received $700.00' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This search expired. Look the client up again to collect.');
  });

  it('says when there were too many searches', async () => {
    override = (path) => {
      if (path.startsWith('/reseller-app/collect/lookup')) throw new ApiRequestError('Too many requests', 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/cobrar');
    await user.type(screen.getByLabelText('Customer number or phone'), '#58');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many searches in a short time.');
  });

  it('rejects an amount above the selected invoices', async () => {
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    const amount = await screen.findByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '800');
    await user.click(screen.getByRole('button', { name: 'Collect $800.00 in cash' }));
    expect(screen.getByRole('alert')).toHaveTextContent('cannot be more than the selected invoices ($700.00)');
  });

  it('keeps the amount, the confirm step and the token when the app regains focus or the network', async () => {
    // Each answer carries a new token, as the server signs one per call.
    let issued = 0;
    override = (path) => {
      if (path === '/reseller-app/collect/client/31') { issued += 1; return { data: { ...OWN, collect_token: `tok-own-${issued}` } }; }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    const amount = await screen.findByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '120');
    await user.click(screen.getByRole('button', { name: 'Collect $120.00 in cash' }));
    expect(screen.getByRole('heading', { name: 'Did you receive the cash?' })).toBeInTheDocument();

    // The reseller switches apps, or the connection drops and comes back.
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    act(() => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(calls('GET', '/reseller-app/collect/client/31')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Did you receive the cash?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, I received $120.00' }));
    await screen.findByText('Payment of $350.00 recorded.');
    const [post] = calls('POST', '/reseller-app/payments');
    expect(bodyOf(post)).toEqual({ collect_token: 'tok-own-1', amount: 120 });
    act(() => { focusManager.setFocused(undefined); onlineManager.setOnline(true); });
  });
});

describe('Receipt', () => {
  it('is not found for a payment of another reseller', async () => {
    override = (path) => {
      if (path === '/reseller-app/payments/77/receipt') throw new ApiRequestError('Not found', 404);
      return undefined;
    };
    renderAt('/punto/recibo/77');
    expect(await screen.findByText('This receipt does not exist or is not from your point of sale.')).toBeInTheDocument();
  });

  it('says a voided collection was voided', async () => {
    override = (path) => (path === '/reseller-app/payments/101/receipt' ? { data: { ...RECEIPT, status: 'voided' } } : undefined);
    renderAt('/punto/recibo/101');
    expect(await screen.findByText('This payment was voided.')).toBeInTheDocument();
    const wa = screen.getByRole('link', { name: 'Send by WhatsApp' }).getAttribute('href') ?? '';
    expect(decodeURIComponent(wa)).toContain('This payment was voided.');
  });
});

describe('Mi caja', () => {
  it('shows the open cash box, today, previous boxes and the movements', async () => {
    renderAt('/punto/caja');
    const open = await screen.findByRole('region', { name: 'Your cash box' });
    expect(open).toHaveTextContent('Open');
    expect(open).toHaveTextContent('$700.00');
    expect(open).toHaveTextContent('2 payments since');
    const today = screen.getByRole('region', { name: "Today's payments" });
    expect(await within(today).findByText('Ana López')).toBeInTheDocument();
    const voided = within(today).getByText('Ma*** Ló***').closest('li')!;
    expect(within(voided).getByText('Voided')).toBeInTheDocument();
    expect(within(voided).queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Previous cash boxes' })).toHaveTextContent('$10.00 short');
    const ledger = screen.getByRole('region', { name: 'Movements' });
    expect(await within(ledger).findByText('Cash handed in')).toBeInTheDocument();
    expect(within(ledger).getByText('+$350.00')).toBeInTheDocument();
    expect(within(ledger).getByText('-$500.00')).toBeInTheDocument();
  });

  it('labels the commission lines with their invoice and a negative balance as owed to the reseller', async () => {
    override = (path) => (path.startsWith('/reseller-app/ledger?') ? {
      data: [
        { id: 6, entry_type: 'payout', amount: '20.00', note: null, created_at: '2026-11-07T19:00:00Z', payment_id: null, invoice_number: null },
        { id: 5, entry_type: 'commission_reversal', amount: '38.79', note: null, created_at: '2026-11-07T18:00:00Z', payment_id: null, invoice_number: 'F-0811' },
        { id: 4, entry_type: 'commission', amount: '-38.79', note: null, created_at: '2026-11-07T17:00:00Z', payment_id: null, invoice_number: 'F-0811' },
      ],
      summary: { balance: '-12.00', cash_on_hand: '-12.00', credit_limit: '2000.00', available_to_collect: '2012.00' },
      meta: { total: 3, page: 1, limit: 20 },
    } : undefined);
    renderAt('/punto/caja');
    const ledger = await screen.findByRole('region', { name: 'Movements' });
    const earned = (await within(ledger).findByText('Commission earned')).closest('li')!;
    expect(earned).toHaveTextContent('Invoice F-0811');
    expect(earned).toHaveTextContent('-$38.79');
    expect(within(ledger).getByText('Commission reversed').closest('li')).toHaveTextContent('+$38.79');
    expect(within(ledger).getByText('Payment from the company').closest('li')).toHaveTextContent('+$20.00');
    expect(within(ledger).getByText('We owe you').nextElementSibling).toHaveTextContent('$12.00');
    expect(within(ledger).queryByText('You must hand in')).not.toBeInTheDocument();
  });

  it('voids a collection with a reason', async () => {
    const user = userEvent.setup();
    renderAt('/punto/caja');
    const today = await screen.findByRole('region', { name: "Today's payments" });
    const row = (await within(today).findByText('Ana López')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    await user.type(within(row).getByLabelText('Why are you voiding it?'), 'no');
    await user.click(within(row).getByRole('button', { name: 'Void payment' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('3 to 200 characters');
    expect(calls('POST', '/reseller-app/payments/101/void')).toHaveLength(0);

    await user.type(within(row).getByLabelText('Why are you voiding it?'), ' era otro cliente');
    const sessionReads = calls('GET', '/reseller-app/cash-session').length;
    await user.click(within(row).getByRole('button', { name: 'Void payment' }));
    await waitFor(() => expect(calls('POST', '/reseller-app/payments/101/void')).toHaveLength(1));
    expect(bodyOf(calls('POST', '/reseller-app/payments/101/void')[0])).toEqual({ reason: 'no era otro cliente' });
    // The box, the list, the ledger and /me are read again.
    await waitFor(() => expect(calls('GET', '/reseller-app/cash-session').length).toBeGreaterThan(sessionReads));
  });

  it('shows the server refusal of a void', async () => {
    override = (path, init) => {
      if (path === '/reseller-app/payments/101/void' && init?.method === 'POST') {
        throw new ApiRequestError('A complemento de pago was already stamped for this payment.', 409, { error: { code: 'CONFLICT', message: 'A complemento de pago was already stamped for this payment.' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/caja');
    const row = (await screen.findByText('Ana López')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    await user.type(within(row).getByLabelText('Why are you voiding it?'), 'error de captura');
    await user.click(within(row).getByRole('button', { name: 'Void payment' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('complemento de pago was already stamped');
  });

  it.each([
    ['VOID_WINDOW_CLOSED', "Only today's payments can be voided. Ask the company to correct it."],
    ['CASH_SESSION_CLOSED', 'The cash box of this payment is already closed. Ask the company to correct it.'],
    ['PAYMENT_HAS_REP', 'This payment is already reported to SAT with a payment complement. Ask the company to cancel it.'],
    ['ALREADY_VOIDED', 'This payment was already voided.'],
    ['NOT_YOUR_COLLECTION', 'Only the person who took this cash can void it.'],
    ['CASH_SEALED_IN_BAG', 'The cash of this payment is already sealed in a cash bag. Ask the company to correct it.'],
    ['LOCK_CONTENTION', 'This payment changed while it was being voided. Try again.'],
  ])('explains the %s refusal of a void in the reader\'s language', async (code, text) => {
    override = (path, init) => {
      if (path === '/reseller-app/payments/101/void' && init?.method === 'POST') {
        throw new ApiRequestError('Refused in English', 409, { error: { code, message: 'Refused in English' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/caja');
    const row = (await screen.findByText('Ana López')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    await user.type(within(row).getByLabelText('Why are you voiding it?'), 'error de captura');
    const sessionReads = calls('GET', '/reseller-app/cash-session').length;
    await user.click(within(row).getByRole('button', { name: 'Void payment' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent(text);
    // The row was out of date: the box and the list are read again.
    await waitFor(() => expect(calls('GET', '/reseller-app/cash-session').length).toBeGreaterThan(sessionReads));
  });

  it('follows the server on which collections may be voided', async () => {
    override = (path) => (path.startsWith('/reseller-app/payments?')
      ? { data: [{ ...COLLECTIONS[0], voidable: false }], meta: { total: 1, page: 1, limit: 20 } }
      : undefined);
    renderAt('/punto/caja');
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it('closes the cash box with the counted total, showing the difference first', async () => {
    const user = userEvent.setup();
    renderAt('/punto/caja');
    const form = await screen.findByRole('form', { name: 'Close cash box' });
    await user.type(within(form).getByLabelText('Cash counted'), '690');
    expect(form).toHaveTextContent('$10.00 short');
    await user.click(within(form).getByRole('button', { name: 'Close cash box' }));
    expect(form).toHaveTextContent('Close the cash box with $690.00 counted?');
    expect(calls('POST', '/reseller-app/cash-session/close')).toHaveLength(0);
    await user.click(within(form).getByRole('button', { name: 'Yes, close the cash box' }));
    expect(await screen.findByText('Cash box closed.')).toBeInTheDocument();
    expect(bodyOf(calls('POST', '/reseller-app/cash-session/close')[0])).toEqual({ counted_total: 690 });
  });

  it('offers neither void nor close without reseller_app.collect', async () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use'] };
    renderAt('/punto/caja');
    expect(await screen.findByText('Ana López')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Close cash box' })).not.toBeInTheDocument();
  });

  it('says when no cash box is open', async () => {
    override = (path) => (path === '/reseller-app/cash-session' ? { data: { current: null, recent: [] } } : undefined);
    renderAt('/punto/caja');
    expect(await screen.findByText('No cash box is open. It opens by itself with your first payment.')).toBeInTheDocument();
    // The card is not titled "open" when no cash box is open.
    const box = screen.getByRole('region', { name: 'Your cash box' });
    expect(box).toHaveTextContent('Closed');
    expect(box).not.toHaveTextContent('Open cash box');
    expect(screen.queryByRole('form', { name: 'Close cash box' })).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations on the collect form, the receipt and Mi caja', async () => {
    const user = userEvent.setup();
    const collect = renderAt('/punto/cobrar?cliente=31');
    await screen.findByLabelText('Amount received');
    expect(await axe(collect.container)).toHaveNoViolations();
    collect.unmount();

    const receipt = renderAt('/punto/recibo/101');
    await screen.findByRole('article', { name: 'Payment receipt' });
    expect(await axe(receipt.container)).toHaveNoViolations();
    receipt.unmount();

    const cash = renderAt('/punto/caja');
    const row = (await screen.findByText('Ana López')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Void' }));
    await screen.findByText('Cash handed in');
    expect(await axe(cash.container)).toHaveNoViolations();
  });
});
