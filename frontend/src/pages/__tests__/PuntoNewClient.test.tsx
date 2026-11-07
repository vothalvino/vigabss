// =============================================================================
// Reseller app — Nuevo cliente: the sign-up payload and the coverage summary
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PuntoNewClient } from '../punto/PuntoNewClient';

const RESELLER_USER = {
  id: 7, role: 'billing', organization_currency: 'MXN',
  permissions: ['reseller_app.use', 'reseller_app.signup'],
  reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' },
};
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), user: null as unknown }));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

const PLANS = [
  { id: 3, name: 'Fibra 100', price: '499.00', download_speed: 100, upload_speed: 50 },
  { id: 4, name: 'Fibra 300', price: '699.00', download_speed: 300, upload_speed: 150 },
];
const ME = { reseller: { id: 4, name: 'Punto Norte', level: 1, status: 'active', commission_rate: '10.00', parent_id: null }, currency: 'MXN', counts: { active_clients: 0, suspended_clients: 0, open_leads: 0, overdue_clients: 0 } };

let feasibility: unknown;

function setup() {
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/reseller-app/me') return { data: ME };
    if (path === '/reseller-app/plans') return { data: PLANS };
    if (path === '/reseller-app/leads' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string; phone: string };
      return { data: { id: 88, name: body.name, phone: body.phone, status: 'new', desired_plan_id: 3, desired_plan_name: 'Fibra 100', created_at: '2026-11-06T10:00:00Z', converted_client_id: null } };
    }
    if (path === '/reseller-app/leads/88/feasibility') {
      if (feasibility instanceof Error) throw feasibility;
      return { data: feasibility };
    }
    throw new Error(`unexpected request ${path}`);
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/punto/nuevo']}>
        <Routes>
          <Route path="/punto/nuevo" element={<PuntoNewClient />} />
          <Route path="/punto" element={<p>punto home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockGeolocation(impl: (ok: PositionCallback, fail: PositionErrorCallback) => void) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => impl(ok, fail)) },
  });
}

function postedBody(): Record<string, unknown> {
  const call = mocks.apiFetch.mock.calls.find(([path, init]) => path === '/reseller-app/leads' && init?.method === 'POST');
  expect(call).toBeTruthy();
  return JSON.parse(String((call![1] as RequestInit).body));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = RESELLER_USER;
  // The server's reseller summary (routes/resellerApp.js), not the staff payload.
  feasibility = {
    has_coordinates: true,
    covered: true,
    coverage_zones: [{ name: 'Centro', zone_type: 'fiber', status: 'active', max_download_mbps: 300, max_upload_mbps: 150 }],
    zone_lookup_failed: false,
    wireless: { nearby: true, distance_band: 'under_3km' },
    ftth: { nearby: true, distance_band: 'under_1km', has_free_ports: true },
  };
});
afterEach(() => { Reflect.deleteProperty(navigator, 'geolocation'); });

describe('PuntoNewClient', () => {
  it('posts the sign-up with location, plan and tax data, then shows coverage', async () => {
    mockGeolocation(ok => ok({ coords: { latitude: 19.4326077, longitude: -99.133208 } } as GeolocationPosition));
    setup();
    const user = userEvent.setup();

    await screen.findByRole('option', { name: /Fibra 100 · \$499\.00 · 100\/50 Mbps/ });
    await user.type(screen.getByLabelText(/Full name/), '  María Pérez ');
    await user.type(screen.getByLabelText(/^Phone/), '5512345678');
    await user.type(screen.getByLabelText('Email'), 'maria@example.com');
    await user.type(screen.getByLabelText('Address'), 'Av. Juárez 10');
    await user.type(screen.getByLabelText('City or town'), 'CDMX');
    await user.selectOptions(screen.getByLabelText('Plan of interest'), '3');
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(screen.getByText(/Location saved: 19.432608, -99.133208/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tax details/ }));
    await user.type(screen.getByLabelText('RFC'), 'pexm800101ab1');
    await user.type(screen.getByLabelText(/Legal name/), 'María Pérez');
    await user.selectOptions(screen.getByLabelText(/Tax regime/), '626');
    await user.type(screen.getByLabelText('Tax postal code'), '06000');
    await user.type(screen.getByLabelText('Notes'), 'Llamar después de las 6');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));

    expect(await screen.findByText('Sign-up saved')).toBeInTheDocument();
    expect(postedBody()).toEqual({
      name: 'María Pérez',
      phone: '5512345678',
      email: 'maria@example.com',
      address: 'Av. Juárez 10',
      city: 'CDMX',
      desired_plan_id: 3,
      latitude: 19.432608,
      longitude: -99.133208,
      rfc: 'PEXM800101AB1',
      razon_social: 'María Pérez',
      regimen_fiscal: '626',
      codigo_postal_fiscal: '06000',
      notes: 'Llamar después de las 6',
    });

    const coverage = screen.getByRole('region', { name: 'Coverage' });
    expect(await within(coverage).findByText(/inside a coverage zone/)).toBeInTheDocument();
    expect(within(coverage).getByText('Coverage zone: Centro')).toBeInTheDocument();
    expect(within(coverage).getByText('Antenna less than 3 km away')).toBeInTheDocument();
    expect(within(coverage).getByText('Fiber box less than 1 km away with free ports.')).toBeInTheDocument();
    expect(mocks.apiFetch).toHaveBeenCalledWith('/reseller-app/leads/88/feasibility');
    expect(screen.getByRole('link', { name: 'View my prospects' })).toHaveAttribute('href', '/punto/prospectos');
  });

  it('sends only name and phone when nothing else is filled', async () => {
    feasibility = {
      has_coordinates: false, covered: false, coverage_zones: [], zone_lookup_failed: false,
      wireless: { nearby: false, distance_band: null }, ftth: { nearby: false, distance_band: null, has_free_ports: null },
    };
    setup();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    expect(await screen.findByText(/No location was saved/)).toBeInTheDocument();
    expect(postedBody()).toEqual({ name: 'Luis', phone: '5599990000' });
  });

  it('requires name and phone and checks the RFC before sending', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name and phone are required.');

    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: /Tax details/ }));
    await user.type(screen.getByLabelText('RFC'), 'ABC');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/RFC does not look valid/);
    expect(mocks.apiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('explains a denied location and still saves without it', async () => {
    mockGeolocation((_ok, fail) => fail({ code: 1, message: 'denied' } as GeolocationPositionError));
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Location permission was denied/);
    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    await screen.findByText('Sign-up saved');
    expect(postedBody()).not.toHaveProperty('latitude');
  });

  it('shows the server refusal of a plan the reseller may not offer', async () => {
    const { ApiRequestError } = await import('@/api/apiFetch');
    setup();
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/reseller-app/plans') return { data: PLANS };
      if (path === '/reseller-app/me') return { data: ME };
      if (init?.method === 'POST') throw new ApiRequestError('desired_plan_id: plan not available to this reseller', 422);
      throw new Error(`unexpected request ${path}`);
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('plan not available to this reseller'));
  });

  async function signUpLuis() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    return screen.findByRole('region', { name: 'Coverage' });
  }

  it('does not promise coverage for a planned or retired zone or far-away network', async () => {
    // The server drops zones not in service and marks a far AP or ODF as
    // "farther"; nothing here may read as coverage.
    feasibility = {
      has_coordinates: true, covered: false, coverage_zones: [], zone_lookup_failed: false,
      wireless: { nearby: false, distance_band: 'farther' }, ftth: { nearby: false, distance_band: 'farther', has_free_ports: null },
    };
    setup();
    const coverage = await signUpLuis();
    expect(await within(coverage).findByText(/No coverage was found near this location/)).toBeInTheDocument();
    expect(within(coverage).queryByText(/Good news|There is network/)).not.toBeInTheDocument();
    expect(within(coverage).queryByText(/Antenna|Fiber box/)).not.toBeInTheDocument();
  });

  it('says there is network nearby when only an antenna is within 3 km', async () => {
    feasibility = {
      has_coordinates: true, covered: false, coverage_zones: [], zone_lookup_failed: false,
      wireless: { nearby: true, distance_band: 'under_1km' }, ftth: { nearby: false, distance_band: 'farther', has_free_ports: null },
    };
    setup();
    const coverage = await signUpLuis();
    expect(await within(coverage).findByText(/There is network near this location/)).toBeInTheDocument();
    expect(within(coverage).getByText('Antenna less than 1 km away')).toBeInTheDocument();
    expect(within(coverage).queryByText(/Fiber box/)).not.toBeInTheDocument();
  });

  it('notes when the coverage zones could not be checked', async () => {
    feasibility = {
      has_coordinates: true, covered: false, coverage_zones: [], zone_lookup_failed: true,
      wireless: { nearby: false, distance_band: null }, ftth: { nearby: false, distance_band: null, has_free_ports: null },
    };
    setup();
    const coverage = await signUpLuis();
    expect(await within(coverage).findByText(/coverage zones could not be checked/)).toBeInTheDocument();
  });

  it('sends an account without reseller_app.signup back to Inicio', async () => {
    mocks.user = { ...RESELLER_USER, permissions: ['reseller_app.use'] };
    setup();
    expect(await screen.findByText('punto home')).toBeInTheDocument();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('says when coverage could not be checked', async () => {
    feasibility = new Error('boom');
    setup();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Full name/), 'Luis');
    await user.type(screen.getByLabelText(/^Phone/), '5599990000');
    await user.click(screen.getByRole('button', { name: 'Save sign-up' }));
    expect(await screen.findByText(/Coverage could not be checked right now/)).toBeInTheDocument();
  });
});
