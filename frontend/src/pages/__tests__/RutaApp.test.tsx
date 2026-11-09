// =============================================================================
// Carrier app (/ruta) — Inicio, Recoger, Entregar, Mi ruta
// =============================================================================
// apiFetch is stubbed and fails on any path outside /carrier-app: the server
// fences a carrier to /auth and /carrier-app. No screen may show an amount.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { configureAxe } from 'jest-axe';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import { RutaLayout } from '../ruta/RutaLayout';
import { RutaHome } from '../ruta/RutaHome';
import { RutaPickup } from '../ruta/RutaPickup';
import { RutaDropoff } from '../ruta/RutaDropoff';
import { RutaBags } from '../ruta/RutaBags';

const CARRIER = { id: 30, name: 'Pedro Ruta', role: 'readonly', carrier: true, permissions: ['carrier_app.use', 'carrier_app.pickup'] };

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

const RESELLERS = [
  { id: 5, name: 'Punto Sur', address: 'Calle 2', city: 'Toluca', phone: null, latitude: null, longitude: null, counts: { ready_for_pickup: 0, empty_bags: 3 } },
  { id: 4, name: 'Punto Norte', address: 'Av. Uno 10', city: 'Puebla', phone: '222 555 0101', latitude: '19.0412345', longitude: '-98.2061234', counts: { ready_for_pickup: 2, empty_bags: 1 } },
];
const BAGS = [
  { serial: 'B-0001', status: 'with_carrier' },
  { serial: 'B-0002', status: 'with_carrier' },
  { serial: 'A-0100', status: 'in_transit', reseller_name: 'Punto Norte' },
];

type Handler = (path: string, init?: RequestInit) => unknown;
let override: Handler | null = null;

function respond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (!path.startsWith('/carrier-app/')) throw new Error(`a carrier may not call ${method} ${path}`);
  if (override) {
    const r = override(path, init);
    if (r !== undefined) return r;
  }
  if (path === '/carrier-app/me') return { data: { carrier: { id: 30, name: 'Pedro Ruta' }, counts: { stock: 2, in_transit: 1, assigned_resellers: 2 } } };
  if (path === '/carrier-app/resellers') return { data: RESELLERS };
  if (path === '/carrier-app/bags') return { data: BAGS };
  if (path === '/carrier-app/pickup' && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    if (body.reseller_id === 4 && body.serial === 'A-0101') return { data: { serial: 'A-0101', status: 'in_transit', reseller_name: 'Punto Norte' } };
    throw new ApiRequestError('Not found', 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  if (path === '/carrier-app/dropoff' && method === 'POST') {
    const body = JSON.parse(String(init?.body));
    return { data: { bags: body.serials.map((s: string) => ({ serial: s, status: 'at_reseller' })) } };
  }
  throw new Error(`unexpected request ${method} ${path}`);
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<RutaLayout />}>
            <Route path="/ruta" element={<RutaHome />} />
            <Route path="/ruta/recoger" element={<RutaPickup />} />
            <Route path="/ruta/entregar" element={<RutaDropoff />} />
            <Route path="/ruta/mis-bolsas" element={<RutaBags />} />
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
  Reflect.deleteProperty(globalThis, 'BarcodeDetector');
  mocks.user = CARRIER;
  override = null;
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => respond(path, init));
});
afterEach(async () => {
  Reflect.deleteProperty(globalThis, 'BarcodeDetector');
  await i18n.changeLanguage('en');
});

describe('RutaLayout', () => {
  it('shows the carrier name and the four tabs, in Spanish too', async () => {
    renderAt('/ruta');
    expect(await screen.findByText('Pedro Ruta')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    expect(within(nav).getAllByRole('link').map(l => l.textContent)).toEqual(['Home', 'Pick up', 'Drop off', 'My route']);
    await i18n.changeLanguage('es');
    expect(within(screen.getByRole('navigation', { name: 'Menú principal' })).getAllByRole('link').map(l => l.textContent))
      .toEqual(['Inicio', 'Recoger', 'Entregar', 'Mi ruta']);
  });

  it('explains a missing carrier_app.use and makes no request', () => {
    mocks.user = { ...CARRIER, permissions: [] };
    renderAt('/ruta');
    expect(screen.getByRole('alert')).toHaveTextContent('No access to the route app');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('hides Pick up and Drop off without carrier_app.pickup', async () => {
    mocks.user = { ...CARRIER, permissions: ['carrier_app.use'] };
    renderAt('/ruta');
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    expect(within(nav).getAllByRole('link').map(l => l.textContent)).toEqual(['Home', 'My route']);
    expect(await screen.findByRole('heading', { name: 'Punto Norte' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pick up at Punto Norte' })).not.toBeInTheDocument();
  });
});

describe('Inicio', () => {
  it('lists the assigned resellers, ready ones first, with phone and map links and no amounts', async () => {
    const { container } = renderAt('/ruta');
    const list = await screen.findByRole('region', { name: 'Your resellers' });
    await within(list).findByRole('heading', { name: 'Punto Norte' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards.map(c => within(c).getByRole('heading').textContent)).toEqual(['Punto Norte', 'Punto Sur']);
    expect(within(cards[0]).getByText('2 ready')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Av. Uno 10, Puebla')).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: 'Call 222 555 0101' })).toHaveAttribute('href', 'tel:2225550101');
    expect(within(cards[0]).getByRole('link', { name: 'Open map' }).getAttribute('href')).toContain('19.0412345,-98.2061234');
    expect(within(cards[0]).getByRole('link', { name: 'Pick up at Punto Norte' })).toHaveAttribute('href', '/ruta/recoger?punto=4');
    // Nothing to pick up at Punto Sur, and no coordinates or phone.
    expect(within(cards[1]).getByText('Nothing to pick up')).toBeInTheDocument();
    expect(within(cards[1]).queryByRole('link', { name: /Pick up at/ })).not.toBeInTheDocument();
    expect(within(cards[1]).queryByRole('link', { name: 'Open map' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your bags' })).toHaveTextContent('2');
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('says so when no reseller is assigned', async () => {
    override = (path) => (path === '/carrier-app/resellers' ? { data: [] } : undefined);
    renderAt('/ruta');
    expect(await screen.findByText('No reseller is assigned to you yet. Ask the company.')).toBeInTheDocument();
  });
});

describe('Recoger', () => {
  it('confirms a typed serial matched and shows it on its way (no camera without BarcodeDetector)', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/ruta/recoger?punto=4');
    const select = await screen.findByLabelText('Reseller');
    await waitFor(() => expect(select).toHaveValue('4'));
    expect(screen.queryByRole('button', { name: 'Scan with the camera' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Bag number'), '  a-0101 ');
    await user.click(screen.getByRole('button', { name: 'Confirm pickup' }));

    const done = await screen.findByRole('region', { name: 'Picked up' });
    expect(within(done).getByText('A-0101')).toBeInTheDocument();
    expect(within(done).getByText('Matched · On its way')).toBeInTheDocument();
    const [post] = calls('POST', '/carrier-app/pickup');
    expect(bodyOf(post)).toEqual({ reseller_id: 4, serial: 'A-0101' });
    expect(screen.getByLabelText('Bag number')).toHaveValue('');
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('refuses a serial that is not a ready bag of that reseller without saying why', async () => {
    const user = userEvent.setup();
    renderAt('/ruta/recoger?punto=4');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('4'));
    await user.type(screen.getByLabelText('Bag number'), 'Z-9999');
    await user.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That bag is not ready for pickup at this reseller. Check the number.');
    expect(screen.queryByRole('region', { name: 'Picked up' })).not.toBeInTheDocument();
  });

  it('asks for the reseller first', async () => {
    const user = userEvent.setup();
    renderAt('/ruta/recoger');
    await screen.findByLabelText('Reseller');
    await user.type(screen.getByLabelText('Bag number'), 'A-0101');
    await user.click(screen.getByRole('button', { name: 'Confirm pickup' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the reseller first.');
    expect(calls('POST', '/carrier-app/pickup')).toHaveLength(0);
  });

  it('offers the camera where BarcodeDetector and a camera exist', async () => {
    Reflect.set(globalThis, 'BarcodeDetector', class { async detect() { return []; } });
    const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
    try {
      renderAt('/ruta/recoger?punto=4');
      expect(await screen.findByRole('button', { name: 'Scan with the camera' })).toBeInTheDocument();
      // The typed field is always there.
      expect(screen.getByLabelText('Bag number')).toBeInTheDocument();
    } finally {
      if (media) Object.defineProperty(navigator, 'mediaDevices', media);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });
});

describe('Entregar bolsas vacías', () => {
  it('drops off typed and tapped serials at a reseller in one request', async () => {
    const user = userEvent.setup();
    renderAt('/ruta/entregar?punto=5');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('5'));
    await user.type(screen.getByLabelText('Bag number'), 'b-0001');
    await user.click(screen.getByRole('button', { name: 'Add bag' }));
    const stock = screen.getByRole('region', { name: 'Your empty bags' });
    await user.click(await within(stock).findByRole('button', { name: 'B-0002' }));
    expect(screen.getByRole('region', { name: '2 bags to drop off' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Drop off 2 bags' }));
    expect(await screen.findByText('2 bags left at Punto Sur.')).toBeInTheDocument();
    const [post] = calls('POST', '/carrier-app/dropoff');
    expect(bodyOf(post)).toEqual({ reseller_id: 5, serials: ['B-0001', 'B-0002'] });
  });

  it('keeps the list and names the serials refused when nothing was saved', async () => {
    override = (path, init) => {
      if (path === '/carrier-app/dropoff' && init?.method === 'POST') {
        throw new ApiRequestError('Some bags cannot be dropped off', 422, { error: { code: 'BAGS_NOT_AVAILABLE', message: 'x', details: { failed: ['X-1'] } } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/ruta/entregar?punto=5');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('5'));
    for (const s of ['B-0001', 'X-1']) {
      await user.type(screen.getByLabelText('Bag number'), s);
      await user.click(screen.getByRole('button', { name: 'Add bag' }));
    }
    await user.click(screen.getByRole('button', { name: 'Drop off 2 bags' }));
    expect(await screen.findByText(/Nothing was saved\. These bags are not in your stock: X-1\./)).toBeInTheDocument();
    const list = screen.getByRole('region', { name: '2 bags to drop off' });
    expect(within(list).getByText('X-1 · not in your stock')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Remove X-1' }));
    expect(screen.getByRole('region', { name: '1 bag to drop off' })).toBeInTheDocument();
  });

  it('offers only the bags for the chosen point, names where the others go, and explains a bag for another point', async () => {
    override = (path, init) => {
      if (path === '/carrier-app/bags') {
        return { data: [
          { serial: 'B-0001', status: 'with_carrier', reseller_id: 5, reseller_name: 'Punto Sur' },
          { serial: 'B-0002', status: 'with_carrier', reseller_id: null, reseller_name: null },
          { serial: 'N-0001', status: 'with_carrier', reseller_id: 4, reseller_name: 'Punto Norte' },
        ] };
      }
      if (path === '/carrier-app/dropoff' && init?.method === 'POST') {
        throw new ApiRequestError('For another point', 422, { error: { code: 'BAGS_FOR_ANOTHER_POINT', message: 'x', details: { failed: ['N-0001'] } } });
      }
      return undefined;
    };
    const user = userEvent.setup();
    renderAt('/ruta/entregar?punto=5');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('5'));
    const stock = screen.getByRole('region', { name: 'Your empty bags' });
    expect(await within(stock).findByRole('button', { name: 'B-0001' })).toBeInTheDocument();
    expect(within(stock).getByRole('button', { name: 'B-0002' })).toBeInTheDocument();
    expect(within(stock).queryByRole('button', { name: 'N-0001' })).toBeNull();
    expect(within(within(stock).getByRole('list', { name: 'Bags for other points' })).getByText(/for Punto Norte/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Bag number'), 'N-0001');
    await user.click(screen.getByRole('button', { name: 'Add bag' }));
    await user.click(screen.getByRole('button', { name: 'Drop off 1 bag' }));
    expect(await screen.findByText(/These bags are for another point: N-0001\./)).toBeInTheDocument();
  });

  it('does not add a serial twice', async () => {
    const user = userEvent.setup();
    renderAt('/ruta/entregar?punto=5');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('5'));
    for (let i = 0; i < 2; i++) {
      await user.type(screen.getByLabelText('Bag number'), 'B-0001');
      await user.click(screen.getByRole('button', { name: 'Add bag' }));
    }
    expect(screen.getByRole('alert')).toHaveTextContent('B-0001 is already in the list.');
  });
});

describe('Mi ruta', () => {
  it('lists the bags in hand, in transit with their reseller, and no amounts', async () => {
    const { container } = renderAt('/ruta/mis-bolsas');
    const transit = await screen.findByRole('region', { name: 'On its way (1)' });
    expect(within(transit).getByText('A-0100')).toBeInTheDocument();
    expect(within(transit).getByText('From Punto Norte')).toBeInTheDocument();
    const stock = screen.getByRole('region', { name: 'Empty bags to drop off (2)' });
    expect(within(stock).getByText('B-0001')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$/);
  });
});

describe('accessibility', () => {
  it('has no axe violations on Inicio, Recoger and Entregar', async () => {
    const home = renderAt('/ruta');
    await screen.findByRole('heading', { name: 'Punto Norte' });
    expect(await axe(home.container)).toHaveNoViolations();
    home.unmount();
    const pickup = renderAt('/ruta/recoger?punto=4');
    await waitFor(() => expect(screen.getByLabelText('Reseller')).toHaveValue('4'));
    expect(await axe(pickup.container)).toHaveNoViolations();
    pickup.unmount();
    const drop = renderAt('/ruta/entregar?punto=5');
    await screen.findByRole('button', { name: 'B-0002' });
    expect(await axe(drop.container)).toHaveNoViolations();
  });
});
