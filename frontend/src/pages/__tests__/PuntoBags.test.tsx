// =============================================================================
// Reseller app (/punto), cash bags — Mis bolsas, the Inicio card, Cobrar's
// cash-limit hint and the Mi caja card title
// =============================================================================
// Like PuntoCollect.test.tsx these stub apiFetch and fail on any path outside
// /reseller-app: a reseller-bound account may not call staff endpoints.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureAxe } from 'jest-axe';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import { PuntoLayout } from '../punto/PuntoLayout';
import { PuntoHome } from '../punto/PuntoHome';
import { PuntoCollect } from '../punto/PuntoCollect';
import { PuntoCash } from '../punto/PuntoCash';
import { PuntoBags } from '../punto/PuntoBags';

const PERMS = ['reseller_app.use', 'reseller_app.signup', 'reseller_app.collect', 'reseller_app.bags'];
const RESELLER_USER = { id: 7, role: 'billing', organization_currency: 'MXN', permissions: PERMS, reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' } };

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), logout: vi.fn(async () => {}), user: null as unknown }));

vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mocks.user, logout: mocks.logout }) }));

// At the limit: 2,000 owed, 500 already in a sealed bag, 1,500 in hand.
const MONEY = {
  currency: 'MXN', balance: '2000.00', in_bags: '500.00', cash_on_hand: '1500.00', credit_limit: '1500.00',
  available_to_collect: '0.00', collected_today: '350.00', empty_bags: 2,
};
let money: Record<string, unknown> = MONEY;
const me = () => ({
  data: {
    reseller: { id: 4, name: 'Punto Norte', level: 1, status: 'active', commission_rate: '10.00', parent_id: null },
    currency: 'MXN',
    counts: { active_clients: 12, suspended_clients: 3, open_leads: 5, overdue_clients: 2 },
    money,
  },
});
const BAGS = [
  { id: 11, serial: 'B-0011', status: 'at_reseller', declared_amount: null, sealed_at: null, picked_up_at: null },
  { id: 12, serial: 'B-0012', status: 'at_reseller', declared_amount: null, sealed_at: null, picked_up_at: null },
  { id: 9, serial: 'B-0009', status: 'ready_for_pickup', declared_amount: '500.00', sealed_at: '2026-11-07T15:00:00Z', picked_up_at: null },
  { id: 8, serial: 'B-0008', status: 'in_transit', declared_amount: '800.00', sealed_at: '2026-11-06T15:00:00Z', picked_up_at: '2026-11-06T18:00:00Z' },
];
const OWN = {
  collect_token: 'tok-own', own: true, client_number: 31, name: 'Ana López', status: 'active', amount_due: '350.00',
  open_invoices: [{ id: 9, invoice_number: 'F-0009', balance: '350.00', due_date: '2026-10-05' }],
};

type Handler = (path: string, init?: RequestInit) => unknown;
let override: Handler | null = null;

function respond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (!path.startsWith('/reseller-app/')) throw new Error(`a bound account may not call ${method} ${path}`);
  if (override) {
    const r = override(path, init);
    if (r !== undefined) return r;
  }
  if (path === '/reseller-app/me') return me();
  if (path === '/reseller-app/bags') return { data: BAGS };
  if (path === '/reseller-app/bags/seal' && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    return { data: { bag: { id: 11, serial: body.serial, status: 'ready_for_pickup', declared_amount: String(body.declared_amount), sealed_at: '2026-11-07T17:00:00Z', picked_up_at: null }, money: { ...MONEY, cash_on_hand: '0.00', in_bags: '2000.00', available_to_collect: '1500.00' } } };
  }
  if (path === '/reseller-app/collect/client/31') return { data: OWN };
  if (path === '/reseller-app/cash-session') return { data: { current: null, recent: [] } };
  if (path.startsWith('/reseller-app/payments?')) return { data: [], meta: { total: 0, page: 1, limit: 20 } };
  if (path.startsWith('/reseller-app/ledger?')) {
    return {
      data: [
        { id: 4, entry_type: 'adjustment', amount: '10.00', note: 'Declarado 500.00, contado 490.00', created_at: '2026-11-07T19:00:00Z', payment_id: null, cash_bag_id: 7, cash_bag_serial: 'B-0007' },
        { id: 3, entry_type: 'deposit', amount: '-500.00', note: 'Bolsa B-0007', created_at: '2026-11-07T19:00:00Z', payment_id: null, cash_bag_id: 7, cash_bag_serial: 'B-0007' },
      ],
      summary: { balance: '2000.00', in_bags: '500.00', cash_on_hand: '1500.00', credit_limit: '1500.00', available_to_collect: '0.00' },
      meta: { total: 2, page: 1, limit: 20 },
    };
  }
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
            <Route path="/punto/caja" element={<PuntoCash />} />
            <Route path="/punto/bolsas" element={<PuntoBags />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const calls = (method: string, path: string) =>
  mocks.apiFetch.mock.calls.filter(([p, init]) => p === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } }, runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  mocks.user = RESELLER_USER;
  money = MONEY;
  override = null;
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => respond(path, init));
});
afterEach(async () => { await i18n.changeLanguage('en'); });

describe('Mis bolsas', () => {
  it('fills a tapped empty bag with the cash on hand after a confirmation', async () => {
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const summary = await screen.findByRole('region', { name: 'Your cash and bags' });
    expect(within(summary).getByText('Cash outside bags').parentElement).toHaveTextContent('$1,500.00');
    expect(within(summary).getByText('In sealed bags').parentElement).toHaveTextContent('$500.00');

    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0012' }));
    expect(within(form).getByLabelText('Cash in the bag')).toHaveValue('1500.00');
    await user.clear(within(form).getByLabelText('Cash in the bag'));
    await user.type(within(form).getByLabelText('Cash in the bag'), '1200.50');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));

    expect(within(form).getByText('Seal bag B-0012 with $1,200.50?')).toBeInTheDocument();
    expect(calls('POST', '/reseller-app/bags/seal')).toHaveLength(0);
    await user.click(within(form).getByRole('button', { name: 'Yes, seal the bag' }));

    expect(await screen.findByText("Bag B-0012 sealed with $1,200.50. It's ready for the carrier.")).toBeInTheDocument();
    const [post] = calls('POST', '/reseller-app/bags/seal');
    expect(bodyOf(post)).toEqual({ serial: 'B-0012', declared_amount: 1200.5 });
    // The money and the bag list are asked again.
    await waitFor(() => expect(calls('GET', '/reseller-app/me').length).toBeGreaterThan(1));
    await waitFor(() => expect(calls('GET', '/reseller-app/bags').length).toBeGreaterThan(1));
  });

  it('takes a typed serial, normalized like the server does', async () => {
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.type(within(form).getByLabelText('Or scan or type the bag number'), ' b-0011 ');
    await user.click(within(form).getByRole('button', { name: 'Use this bag' }));
    expect(within(form).getByRole('radio', { name: 'B-0011' })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    await user.click(within(form).getByRole('button', { name: 'Yes, seal the bag' }));
    await screen.findByRole('status');
    expect(bodyOf(calls('POST', '/reseller-app/bags/seal')[0])).toEqual({ serial: 'B-0011', declared_amount: 1500 });
  });

  it('refuses more than the cash on hand before asking the server', async () => {
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0011' }));
    const amount = within(form).getByLabelText('Cash in the bag');
    await user.clear(amount);
    await user.type(amount, '1500.01');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('You can put in at most $1,500.00');
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Write an amount above zero with up to two decimals.');
    expect(calls('POST', '/reseller-app/bags/seal')).toHaveLength(0);
  });

  it('shows the server refusal BAG_AMOUNT_EXCEEDS_CASH', async () => {
    override = (path, init) => {
      if (path === '/reseller-app/bags/seal' && init?.method === 'POST') {
        throw new ApiRequestError('Exceeds cash', 409, { error: { code: 'BAG_AMOUNT_EXCEEDS_CASH', message: 'Exceeds cash' } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0011' }));
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    await user.click(within(form).getByRole('button', { name: 'Yes, seal the bag' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('That amount is more than the cash you hold outside bags.');
  });

  it('keeps the refusal, the chosen bag and a typed amount when the refetched cash on hand changed', async () => {
    let refused = false;
    override = (path, init) => {
      if (path === '/reseller-app/bags/seal' && init?.method === 'POST') {
        refused = true;
        throw new ApiRequestError('Exceeds cash', 409, { error: { code: 'BAG_AMOUNT_EXCEEDS_CASH', message: 'Exceeds cash' } });
      }
      // A void elsewhere lowered the cash on hand meanwhile.
      if (path === '/reseller-app/me' && refused) { money = { ...MONEY, cash_on_hand: '800.00', balance: '1300.00' }; }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0011' }));
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    await user.click(within(form).getByRole('button', { name: 'Yes, seal the bag' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('That amount is more than the cash you hold outside bags.');
    // The refetch brought the lower cash: the prefill follows it, nothing else resets.
    await waitFor(() => expect(within(form).getByLabelText('Cash in the bag')).toHaveValue('800.00'));
    expect(within(form).getByRole('alert')).toHaveTextContent('That amount is more than the cash you hold outside bags.');
    expect(within(form).getByRole('radio', { name: 'B-0011' })).toBeChecked();
    // An amount the reseller typed is kept.
    await user.clear(within(form).getByLabelText('Cash in the bag'));
    await user.type(within(form).getByLabelText('Cash in the bag'), '700');
    money = { ...MONEY, cash_on_hand: '750.00' };
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    expect(within(form).getByText('Seal bag B-0011 with $700.00?')).toBeInTheDocument();
  });

  it('keeps the 404 explanation when the bag was taken back and no empty bag is left', async () => {
    let refused = false;
    override = (path, init) => {
      if (path === '/reseller-app/bags/seal' && init?.method === 'POST') {
        refused = true;
        throw new ApiRequestError('Bag not found', 404, { error: { code: 'NOT_FOUND', message: 'Bag not found' } });
      }
      if (path === '/reseller-app/bags' && refused) return { data: BAGS.filter(b => b.status !== 'at_reseller') };
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0011' }));
    await user.click(within(form).getByRole('button', { name: 'Continue' }));
    await user.click(within(form).getByRole('button', { name: 'Yes, seal the bag' }));
    // The form goes away with the last empty bag; its explanation stays.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fill a bag' })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('That bag is not one of your empty bags. Check the number.');
  });

  it('lists the bags waiting for the carrier and on their way, with what was declared', async () => {
    renderAt('/punto/bolsas');
    const ready = await screen.findByRole('region', { name: 'Waiting for the carrier' });
    expect(within(ready).getByText('B-0009')).toBeInTheDocument();
    expect(within(ready).getByText('$500.00')).toBeInTheDocument();
    const transit = screen.getByRole('region', { name: 'On their way to the company' });
    expect(within(transit).getByText('B-0008')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '2 empty bags' })).toHaveTextContent('B-0011, B-0012');
  });

  it('says it needs reseller_app.bags and asks nothing', () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use'] };
    renderAt('/punto/bolsas');
    expect(screen.getByRole('alert')).toHaveTextContent("Your account can't use cash bags.");
    expect(calls('GET', '/reseller-app/bags')).toHaveLength(0);
  });
});

describe('Inicio', () => {
  it('shows the bags card and, at the limit, how to keep collecting', async () => {
    renderAt('/punto');
    const card = await screen.findByRole('region', { name: 'My bags' });
    await waitFor(() => expect(within(card).getByText('Empty bags').parentElement).toHaveTextContent('2'));
    expect(within(card).getByText('Cash outside bags').parentElement).toHaveTextContent('$1,500.00 of $1,500.00');
    expect(within(card).getByText(/1 waiting for the carrier/)).toHaveTextContent('1 on its way');
    expect(within(card).getByRole('link', { name: 'Fill a bag' })).toHaveAttribute('href', '/punto/bolsas');
    const moneyCard = screen.getByRole('region', { name: 'Your cash' });
    expect(within(moneyCard).getByRole('link', { name: 'Fill a bag to keep collecting' })).toHaveAttribute('href', '/punto/bolsas');
  });

  it('shows no bags card without reseller_app.bags', async () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use', 'reseller_app.collect'] };
    renderAt('/punto');
    await screen.findByRole('region', { name: 'Your cash' });
    expect(screen.queryByRole('region', { name: 'My bags' })).not.toBeInTheDocument();
    expect(calls('GET', '/reseller-app/bags')).toHaveLength(0);
  });
});

describe('Cobrar at the cash limit', () => {
  function refuseWith(emptyBags: number) {
    money = { ...MONEY, available_to_collect: '1000.00' };
    override = (path, init) => {
      if (path === '/reseller-app/payments' && init?.method === 'POST') {
        throw new ApiRequestError('Credit limit', 409, { error: { code: 'CREDIT_LIMIT', message: 'Credit limit', available_to_collect: '0.00', empty_bags: emptyBags } });
      }
      return undefined;
    };
  }

  it('says to fill a bag, with a link, when an empty bag is at hand', async () => {
    refuseWith(2);
    await i18n.changeLanguage('es');
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Cobrar $350.00 en efectivo' }));
    await user.click(screen.getByRole('button', { name: /Sí, recibí/ }));
    expect(await screen.findByRole('link', { name: 'Llena una bolsa para seguir cobrando' })).toHaveAttribute('href', '/punto/bolsas');
  });

  it('asks to wait for bags or hand in the cash without an empty bag', async () => {
    refuseWith(0);
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $350.00 in cash' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I received $350.00' }));
    expect(await screen.findByText('You have no empty bags: wait for the carrier to bring some, or hand the cash in at the company.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Fill a bag to keep collecting' })).not.toBeInTheDocument();
  });

  it('gives the bag hint on the known limit too, before sending anything', async () => {
    const user = userEvent.setup();
    renderAt('/punto/cobrar?cliente=31');
    await user.click(await screen.findByRole('button', { name: 'Collect $350.00 in cash' }));
    expect(screen.getByRole('link', { name: 'Fill a bag to keep collecting' })).toBeInTheDocument();
    expect(calls('POST', '/reseller-app/payments')).toHaveLength(0);
  });
});

describe('Mi caja', () => {
  it('titles the card by state, links to the bags and names the bag on its ledger lines', async () => {
    await i18n.changeLanguage('es');
    renderAt('/punto/caja');
    const box = await screen.findByRole('region', { name: 'Tu caja' });
    expect(box).toHaveTextContent('Cerrada');
    expect(box).not.toHaveTextContent('Caja abierta');
    expect(screen.getByRole('link', { name: 'Mis bolsas' })).toHaveAttribute('href', '/punto/bolsas');
    const ledger = screen.getByRole('region', { name: 'Movimientos' });
    expect(await within(ledger).findAllByText('Bolsa B-0007')).not.toHaveLength(0);
    expect(within(ledger).getByText('En bolsas selladas').nextElementSibling).toHaveTextContent('$500.00');
    expect(within(ledger).getByText('Efectivo en mano').nextElementSibling).toHaveTextContent('$1,500.00');
  });
});

describe('accessibility', () => {
  it('has no axe violations on Mis bolsas with the confirm step open', async () => {
    const user = userEvent.setup();
    const view = renderAt('/punto/bolsas');
    const form = await screen.findByRole('region', { name: 'Fill a bag' });
    await user.click(within(form).getByRole('radio', { name: 'B-0011' }));
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
