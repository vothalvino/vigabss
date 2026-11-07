// =============================================================================
// Reseller administration: create/edit form, allowed plans, create login
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import ResellerPage from '../ResellerPage';
import { ResellerFormModal } from '../resellers/ResellerFormModal';
import { ResellerAllowedPlansTab } from '../resellers/ResellerAllowedPlansTab';
import { ResellerLedgerTab } from '../resellers/ResellerLedgerTab';
import { ResellerCommissionsTab } from '../resellers/ResellerCommissionsTab';
import { ApiRequestError } from '@/api/apiFetch';
import { ResellerUserBindingsTab } from '../ResellerUserBindingsTab';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  GET: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(),
  permissions: [] as string[],
}));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/api/client', () => ({ api: { GET: mocks.GET, PUT: mocks.PUT, DELETE: mocks.DELETE } }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'manager', organization_currency: 'MXN', permissions: mocks.permissions } }),
}));

const wrap = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>,
);
const callsTo = (method: string, path: string) =>
  mocks.apiFetch.mock.calls.filter(([p, init]) => p === path && (init?.method ?? 'GET') === method);
const bodyOf = (method: string, path: string) => {
  const calls = callsTo(method, path);
  expect(calls).toHaveLength(1);
  return JSON.parse(String((calls[0][1] as RequestInit).body));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions = ['resellers.view', 'resellers.create', 'resellers.update', 'users.update', 'users.create'];
});

describe('ResellerFormModal', () => {
  beforeEach(() => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      return { data: { id: 10 } };
    });
  });

  it('creates a sub-reseller with the right body', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    wrap(<ResellerFormModal mode="create" onClose={onClose} onSaved={onSaved} />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.type(screen.getByLabelText(/^Name/), 'Abarrotes Lupita');
    await user.type(screen.getByLabelText('Contact name'), 'Lupita Gómez');
    await user.type(screen.getByLabelText('Email'), 'lupita@example.com');
    await user.type(screen.getByLabelText('Phone'), '5512340000');
    await user.selectOptions(screen.getByLabelText('Parent reseller (optional)'), '4');
    await user.clear(screen.getByLabelText('Commission (%)'));
    await user.type(screen.getByLabelText('Commission (%)'), '7.5');
    await user.type(screen.getByLabelText('Notes'), 'Esquina con la tienda');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bodyOf('POST', '/resellers')).toEqual({
      name: 'Abarrotes Lupita',
      contact_name: 'Lupita Gómez',
      email: 'lupita@example.com',
      phone: '5512340000',
      parent_id: 4,
      commission_rate: 7.5,
      status: 'active',
      notes: 'Esquina con la tienda',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('creates a top-level reseller without the blank optional fields', async () => {
    wrap(<ResellerFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Name/), 'Punto Sur');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST', '/resellers')).toHaveLength(1));
    expect(bodyOf('POST', '/resellers')).toEqual({ name: 'Punto Sur', commission_rate: 0, status: 'active' });
  });

  it('edits with PUT, never sends parent_id, and refuses a rate over 100', async () => {
    wrap(
      <ResellerFormModal
        mode="edit"
        initial={{ id: 9, name: 'Punto Sur', email: 'sur@example.com', phone: null, contact_name: null, parent_id: 4, parent_name: 'Punto Norte', commission_rate: '10.00', status: 'active', notes: null }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    expect(screen.getByText('Sub-reseller of Punto Norte')).toBeInTheDocument();
    const rate = screen.getByLabelText('Commission (%)');
    await user.clear(rate);
    await user.type(rate, '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('from 0 to 100');
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    await user.clear(rate);
    await user.type(rate, '12');
    await user.selectOptions(screen.getByLabelText('Status'), 'suspended');
    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('PUT', '/resellers/9')).toHaveLength(1));
    expect(bodyOf('PUT', '/resellers/9')).toEqual({ name: 'Punto Sur', commission_rate: 12, status: 'suspended', email: '' });
  });
});

describe('ResellerPage', () => {
  it('shows only the phase-1 tabs and opens the new-reseller form', async () => {
    mocks.permissions = [...mocks.permissions, 'reseller_commissions.view'];
    mocks.apiFetch.mockImplementation(async () => ({ data: [], meta: { total: 0, page: 1, limit: 25 } }));
    wrap(<ResellerPage />);
    const tabs = screen.getAllByRole('button').map(b => b.textContent);
    expect(tabs).toEqual(expect.arrayContaining(['Resellers', 'Allowed plans', 'Commissions', 'Portal', 'Staff access']));
    expect(tabs).not.toContain('Plan Prices');
    expect(tabs).not.toContain('Resources');
    expect(tabs).not.toContain('Billing');
    await userEvent.click(screen.getByRole('button', { name: 'New reseller' }));
    expect(screen.getByRole('dialog', { name: 'New reseller' })).toBeInTheDocument();
  });

  it('refreshes the reseller pickers of the other tabs after a save', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { data: { id: 10 } };
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [] };
      return { data: [], meta: { total: 0, page: 1, limit: 25 } };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(<QueryClientProvider client={qc}><ResellerPage /></QueryClientProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New reseller' }));
    await user.type(screen.getByLabelText(/^Name/), 'Punto Centro');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST', '/resellers')).toHaveLength(1));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resellers-options'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['resellers-top-level'] });
    });
  });

  it('hides New reseller and Edit without the permissions', async () => {
    mocks.permissions = ['resellers.view'];
    mocks.apiFetch.mockImplementation(async () => ({
      data: [{ id: 1, name: 'Punto Norte', level: 1, parent_name: null, commission_rate: '10.00', status: 'active' }],
      meta: { total: 1, page: 1, limit: 25 },
    }));
    wrap(<ResellerPage />);
    await screen.findByText('Punto Norte');
    expect(screen.queryByRole('button', { name: 'New reseller' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('ResellerAllowedPlansTab', () => {
  beforeEach(() => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      if (path.startsWith('/plans?')) {
        return { data: [
          { id: 3, name: 'Fibra 100', price: '499.00', currency: 'MXN', status: 'active' },
          { id: 5, name: 'Fibra 300', price: '699.00', currency: 'MXN', status: 'active' },
          { id: 6, name: 'Viejo 10', price: '199.00', currency: 'MXN', status: 'inactive' },
        ] };
      }
      if (path === '/resellers/4/allowed-plans' && !init?.method) return { data: [{ plan_id: 3, name: 'Fibra 100', price: '499.00' }] };
      if (path === '/resellers/4/allowed-plans' && init?.method === 'PUT') return { data: [] };
      throw new Error(`unexpected ${path}`);
    });
  });

  it('loads the saved set and replaces it', async () => {
    wrap(<ResellerAllowedPlansTab />);
    const user = userEvent.setup();
    expect(screen.getByText(/If none are selected, the reseller can offer every active plan/)).toBeInTheDocument();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    const fibra100 = await screen.findByRole('checkbox', { name: /Fibra 100/ });
    expect(fibra100).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Fibra 300/ })).not.toBeChecked();
    // An inactive plan outside the saved set is not offered.
    expect(screen.queryByRole('checkbox', { name: /Viejo 10/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Fibra 300/ }));
    await user.click(fibra100);
    await user.click(screen.getByRole('button', { name: 'Save allowed plans' }));
    expect(await screen.findByText('Allowed plans saved.')).toBeInTheDocument();
    expect(bodyOf('PUT', '/resellers/4/allowed-plans')).toEqual({ plan_ids: [5] });
  });

  it('saves an empty set (every active plan)', async () => {
    wrap(<ResellerAllowedPlansTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    await user.click(await screen.findByRole('checkbox', { name: /Fibra 100/ }));
    expect(screen.getByText('None selected: the reseller can offer every active plan.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save allowed plans' }));
    await screen.findByText('Allowed plans saved.');
    expect(bodyOf('PUT', '/resellers/4/allowed-plans')).toEqual({ plan_ids: [] });
  });

  it('reads every page of plans, not just the first 100', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `Plan ${String(i + 1).padStart(3, '0')}`, price: '100.00', currency: 'MXN', status: 'active' }));
    const base = mocks.apiFetch.getMockImplementation()!;
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/plans?page=1&limit=100&order_by=name&order=ASC') return { data: page1, meta: { total: 101, page: 1, limit: 100 } };
      if (path === '/plans?page=2&limit=100&order_by=name&order=ASC') {
        return { data: [{ id: 2000, name: 'Plan 101', price: '120.00', currency: 'MXN', status: 'active' }], meta: { total: 101, page: 2, limit: 100 } };
      }
      return base(path, init);
    });
    wrap(<ResellerAllowedPlansTab />);
    await screen.findByRole('option', { name: 'Punto Norte' });
    await userEvent.selectOptions(screen.getByLabelText('Reseller'), '4');
    expect(await screen.findByRole('checkbox', { name: /Plan 101/ })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(101);
    expect(mocks.apiFetch.mock.calls.filter(([p]) => String(p).startsWith('/plans?'))).toHaveLength(2);
  });

  it('is read only without resellers.update', async () => {
    mocks.permissions = ['resellers.view'];
    wrap(<ResellerAllowedPlansTab />);
    await screen.findByRole('option', { name: 'Punto Norte' });
    await userEvent.selectOptions(screen.getByLabelText('Reseller'), '4');
    expect(await screen.findByRole('checkbox', { name: /Fibra 100/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save allowed plans' })).not.toBeInTheDocument();
  });
});

describe('Create login (Staff access tab)', () => {
  const ok = (data: unknown) => Promise.resolve({ data: { data }, error: undefined });
  beforeEach(() => {
    mocks.GET.mockImplementation(() => ok([]));
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }], meta: { total: 1 } };
      return { data: { user_id: 50, email: 'caja@example.com', reseller_id: 4 } };
    });
  });

  async function openTab() {
    wrap(<ResellerUserBindingsTab />);
    await screen.findByRole('option', { name: 'Punto Norte' });
    await userEvent.selectOptions(screen.getByLabelText('Reseller'), '4');
  }

  it('posts the new login for the chosen reseller', async () => {
    await openTab();
    const form = screen.getByRole('form', { name: 'Create login' });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText('First name'), ' Rosa ');
    await user.type(within(form).getByLabelText('Last name'), 'Méndez');
    await user.type(within(form).getByLabelText('Email'), 'caja@example.com');
    await user.type(within(form).getByLabelText('Password'), 'S3gura!2026');
    await user.click(within(form).getByRole('button', { name: 'Create login' }));
    expect(await within(form).findByText('Login created for caja@example.com.')).toBeInTheDocument();
    expect(bodyOf('POST', '/resellers/4/users')).toEqual({
      first_name: 'Rosa', last_name: 'Méndez', email: 'caja@example.com', password: 'S3gura!2026',
    });
    expect(within(form).getByLabelText('Email')).toHaveValue('');
  });

  it('shows the password-policy refusal from the server', async () => {
    const { ApiRequestError } = await import('@/api/apiFetch');
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }], meta: { total: 1 } };
      throw new ApiRequestError('Password must be at least 10 characters', 422);
    });
    await openTab();
    const form = screen.getByRole('form', { name: 'Create login' });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText('First name'), 'Rosa');
    await user.type(within(form).getByLabelText('Last name'), 'Méndez');
    await user.type(within(form).getByLabelText('Email'), 'caja@example.com');
    await user.type(within(form).getByLabelText('Password'), 'short');
    await user.click(within(form).getByRole('button', { name: 'Create login' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Password must be at least 10 characters');
  });

  it('explains which group can use the reseller app', async () => {
    await openTab();
    expect(screen.getByText(/the user must be in a group with the reseller app permissions/)).toBeInTheDocument();
  });

  it('is hidden without users.create', async () => {
    mocks.permissions = ['resellers.view', 'resellers.update', 'users.update'];
    await openTab();
    expect(screen.queryByRole('form', { name: 'Create login' })).not.toBeInTheDocument();
  });
});

describe('ResellerFormModal cash limit', () => {
  beforeEach(() => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [] };
      if (path === '/settings') return { data: [{ key: 'reseller_default_credit_limit', value: '2000.00', scope: 'org', editable: true }] };
      return { data: { id: 10 } };
    });
  });

  it('sends an own limit on create and shows the organization default as the placeholder', async () => {
    mocks.permissions = [...mocks.permissions, 'settings.view'];
    wrap(<ResellerFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    const limit = screen.getByLabelText('Cash limit');
    await waitFor(() => expect(limit).toHaveAttribute('placeholder', 'Organization default: $2,000.00'));
    await user.type(screen.getByLabelText(/^Name/), 'Punto Sur');
    await user.type(limit, '1500.50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST', '/resellers')).toHaveLength(1));
    expect(bodyOf('POST', '/resellers')).toEqual({ name: 'Punto Sur', commission_rate: 0, status: 'active', credit_limit: 1500.5 });
  });

  it('leaves a blank limit out of a create and does not read settings without settings.view', async () => {
    wrap(<ResellerFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    expect(screen.getByLabelText('Cash limit')).toHaveAttribute('placeholder', 'Organization default');
    await user.type(screen.getByLabelText(/^Name/), 'Punto Sur');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST', '/resellers')).toHaveLength(1));
    expect(bodyOf('POST', '/resellers')).not.toHaveProperty('credit_limit');
    expect(callsTo('GET', '/settings')).toHaveLength(0);
  });

  it('clears an own limit with null on edit, and refuses a bad amount', async () => {
    wrap(
      <ResellerFormModal
        mode="edit"
        initial={{ id: 9, name: 'Punto Sur', email: null, phone: null, contact_name: null, parent_id: null, commission_rate: '5.00', status: 'active', notes: null, credit_limit: '1500.00', effective_credit_limit: '1500.00' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const limit = screen.getByLabelText('Cash limit');
    expect(limit).toHaveValue('1500');
    await user.clear(limit);
    await user.type(limit, '12.345');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('0 or more with up to two decimals');
    await user.clear(limit);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('PUT', '/resellers/9')).toHaveLength(1));
    expect(bodyOf('PUT', '/resellers/9')).toEqual({ name: 'Punto Sur', commission_rate: 5, status: 'active', credit_limit: null });
  });

  it('shows the effective default of a reseller already on it', () => {
    wrap(
      <ResellerFormModal
        mode="edit"
        initial={{ id: 9, name: 'Punto Sur', email: null, phone: null, contact_name: null, parent_id: null, commission_rate: '5.00', status: 'active', notes: null, credit_limit: null, effective_credit_limit: '2500.00' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Cash limit')).toHaveAttribute('placeholder', 'Organization default: $2,500.00');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

describe('ResellerFormModal location (for the carrier)', () => {
  beforeEach(() => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [] };
      return { data: { id: 10 } };
    });
  });

  it('sends the address, city and both coordinates on create', async () => {
    wrap(<ResellerFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Name/), 'Punto Sur');
    await user.type(screen.getByLabelText('Address'), 'Av. Juárez 10');
    await user.type(screen.getByLabelText('City'), 'Puebla');
    await user.type(screen.getByLabelText('Latitude'), '19.0414398');
    await user.type(screen.getByLabelText('Longitude'), '-98.2062727');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST', '/resellers')).toHaveLength(1));
    expect(bodyOf('POST', '/resellers')).toEqual({
      name: 'Punto Sur', commission_rate: 0, status: 'active',
      address: 'Av. Juárez 10', city: 'Puebla', latitude: 19.0414398, longitude: -98.2062727,
    });
  });

  it('refuses one coordinate without the other, or one out of range', async () => {
    wrap(
      <ResellerFormModal
        mode="edit"
        initial={{ id: 9, name: 'Punto Sur', email: null, phone: null, contact_name: null, parent_id: null, commission_rate: '5.00', status: 'active', notes: null, address: 'Av. Juárez 10', city: null, latitude: '19.0414398', longitude: '-98.2062727' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    expect(screen.getByLabelText('Address')).toHaveValue('Av. Juárez 10');
    expect(screen.getByLabelText('Latitude')).toHaveValue('19.0414398');
    await user.clear(screen.getByLabelText('Longitude'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter both latitude');
    await user.type(screen.getByLabelText('Longitude'), '-200');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter both latitude');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('clears the address and the pin with null on edit, so the carrier is no longer sent there', async () => {
    wrap(
      <ResellerFormModal
        mode="edit"
        initial={{ id: 9, name: 'Punto Sur', email: null, phone: null, contact_name: null, parent_id: null, commission_rate: '5.00', status: 'active', notes: null, address: 'Av. Juárez 10', city: null, latitude: '19.0414398', longitude: '-98.2062727' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Address'));
    await user.clear(screen.getByLabelText('Latitude'));
    await user.clear(screen.getByLabelText('Longitude'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('PUT', '/resellers/9')).toHaveLength(1));
    // city was never set, so it is not sent.
    expect(bodyOf('PUT', '/resellers/9')).toEqual({
      name: 'Punto Sur', commission_rate: 5, status: 'active', address: null, latitude: null, longitude: null,
    });
  });
});

describe('ResellerLedgerTab', () => {
  const LEDGER = {
    data: [
      { id: 2, entry_type: 'collection', amount: '350.00', note: null, created_at: '2026-11-07T16:05:00Z', payment_id: 101 },
      { id: 1, entry_type: 'deposit', amount: '-500.00', note: 'Entrega semanal', created_at: '2026-11-06T18:00:00Z', payment_id: null },
    ],
    summary: { balance: '850.00', cash_on_hand: '850.00', credit_limit: '2000.00', available_to_collect: '1150.00' },
    meta: { total: 2, page: 1, limit: 25 },
  };
  const wrapRouter = (ui: ReactNode) => wrap(<MemoryRouter>{ui}</MemoryRouter>);

  beforeEach(() => {
    mocks.permissions = ['resellers.view', 'reseller_ledger.view', 'reseller_ledger.manage', 'payments.view'];
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      if (path.startsWith('/resellers/4/ledger?') && !init?.method) return LEDGER;
      if (path === '/resellers/4/ledger' && init?.method === 'POST') return { data: { id: 3 } };
      throw new Error(`unexpected ${path}`);
    });
  });

  it('shows the summary and the movements of a reseller', async () => {
    wrapRouter(<ResellerLedgerTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Cash to hand in').parentElement).toHaveTextContent('$850.00');
    expect(within(summary).getByText('Cash limit').parentElement).toHaveTextContent('$2,000.00');
    expect(within(summary).getByText('Can still collect').parentElement).toHaveTextContent('$1,150.00');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers/4/ledger?page=1&limit=25');
    const deposit = screen.getByText('Entrega semanal').closest('tr')!;
    expect(deposit).toHaveTextContent('Cash handed in');
    expect(deposit).toHaveTextContent('-$500.00');
    expect(screen.getByRole('link', { name: '#101' })).toHaveAttribute('href', '/payments/101');
    expect(screen.getByRole('link', { name: "See this reseller's payments" })).toHaveAttribute('href', '/payments?reseller_id=4');
  });

  it('records a cash hand-in and an adjustment', async () => {
    wrapRouter(<ResellerLedgerTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    const deposit = await screen.findByRole('form', { name: 'Record cash handed in' });
    await user.type(within(deposit).getByLabelText('Amount received'), '-5');
    await user.click(within(deposit).getByRole('button', { name: 'Record hand-in' }));
    expect(within(deposit).getByRole('alert')).toHaveTextContent('greater than zero');
    await user.clear(within(deposit).getByLabelText('Amount received'));
    await user.type(within(deposit).getByLabelText('Amount received'), '500');
    await user.click(within(deposit).getByRole('button', { name: 'Record hand-in' }));
    expect(await screen.findByText('Cash hand-in of $500.00 recorded.')).toBeInTheDocument();
    expect(JSON.parse(String((callsTo('POST', '/resellers/4/ledger')[0][1] as RequestInit).body))).toEqual({ entry_type: 'deposit', amount: 500 });

    const adjustment = screen.getByRole('form', { name: 'Adjustment' });
    await user.type(within(adjustment).getByLabelText('Amount (+ or −)'), '-20');
    await user.click(within(adjustment).getByRole('button', { name: 'Record adjustment' }));
    expect(within(adjustment).getByRole('alert')).toHaveTextContent('An adjustment needs a note.');
    await user.type(within(adjustment).getByLabelText('Note (required)'), 'Billete falso');
    await user.click(within(adjustment).getByRole('button', { name: 'Record adjustment' }));
    await waitFor(() => expect(callsTo('POST', '/resellers/4/ledger')).toHaveLength(2));
    expect(JSON.parse(String((callsTo('POST', '/resellers/4/ledger')[1][1] as RequestInit).body))).toEqual({ entry_type: 'adjustment', amount: -20, note: 'Billete falso' });
  });

  it('is read only without reseller_ledger.manage', async () => {
    mocks.permissions = ['resellers.view', 'reseller_ledger.view'];
    wrapRouter(<ResellerLedgerTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    await screen.findByRole('region', { name: 'Summary' });
    expect(screen.queryByRole('form', { name: 'Record cash handed in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Adjustment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: "See this reseller's payments" })).not.toBeInTheDocument();
  });

  it('shows commission lines with their invoice, a negative balance as owed to the reseller, and records a payout', async () => {
    const ledger = {
      data: [
        { id: 5, entry_type: 'payout', amount: '20.00', note: 'Transferencia', created_at: '2026-11-07T19:00:00Z', payment_id: null, invoice_id: null, invoice_number: null, commission_id: null },
        { id: 4, entry_type: 'commission_reversal', amount: '38.79', note: null, created_at: '2026-11-07T18:00:00Z', payment_id: null, invoice_id: 811, invoice_number: 'F-0811', commission_id: 1 },
        { id: 3, entry_type: 'commission', amount: '-38.79', note: null, created_at: '2026-11-07T17:00:00Z', payment_id: null, invoice_id: 811, invoice_number: 'F-0811', commission_id: 1 },
      ],
      summary: { balance: '-120.50', cash_on_hand: '-120.50', credit_limit: '2000.00', available_to_collect: '2120.50' },
      meta: { total: 3, page: 1, limit: 25 },
    };
    mocks.permissions = [...mocks.permissions, 'invoices.view'];
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      if (path.startsWith('/resellers/4/ledger?') && !init?.method) return ledger;
      if (path === '/resellers/4/ledger' && init?.method === 'POST') return { data: { id: 6 } };
      throw new Error(`unexpected ${path}`);
    });
    wrapRouter(<ResellerLedgerTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Company owes the reseller').parentElement).toHaveTextContent('$120.50');
    expect(within(summary).queryByText('Cash to hand in')).not.toBeInTheDocument();

    const kept = screen.getByText('Commission kept').closest('tr')!;
    expect(kept).toHaveTextContent('-$38.79');
    expect(within(kept).getByRole('link', { name: 'Invoice F-0811' })).toHaveAttribute('href', '/invoices/811');
    const reversed = screen.getByText('Commission reversed').closest('tr')!;
    expect(reversed).toHaveTextContent('+$38.79');
    const payoutRow = screen.getByText('Transferencia').closest('tr')!;
    expect(payoutRow).toHaveTextContent('Payout');

    const payout = screen.getByRole('form', { name: 'Record a payout' });
    expect(payout).toHaveTextContent('The company owes this reseller $120.50.');
    await user.type(within(payout).getByLabelText('Amount paid'), '200');
    await user.click(within(payout).getByRole('button', { name: 'Record payout' }));
    expect(within(payout).getByRole('alert')).toHaveTextContent('cannot be more than what the company owes');
    expect(callsTo('POST', '/resellers/4/ledger')).toHaveLength(0);
    await user.clear(within(payout).getByLabelText('Amount paid'));
    await user.type(within(payout).getByLabelText('Amount paid'), '120.50');
    await user.type(within(payout).getByLabelText('Note (optional)'), 'SPEI 123');
    await user.click(within(payout).getByRole('button', { name: 'Record payout' }));
    expect(await screen.findByText('Payout of $120.50 recorded.')).toBeInTheDocument();
    expect(bodyOf('POST', '/resellers/4/ledger')).toEqual({ entry_type: 'payout', amount: 120.5, note: 'SPEI 123' });
  });

  it('names an invoice without a link without invoices.view, and translates a refused payout', async () => {
    const ledger = {
      data: [{ id: 3, entry_type: 'commission', amount: '-38.79', note: null, created_at: '2026-11-07T17:00:00Z', payment_id: null, invoice_id: 811, invoice_number: 'F-0811', commission_id: 1 }],
      summary: { balance: '-38.79', cash_on_hand: '-38.79', credit_limit: '2000.00', available_to_collect: '2038.79' },
      meta: { total: 1, page: 1, limit: 25 },
    };
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      if (path.startsWith('/resellers/4/ledger?') && !init?.method) return ledger;
      if (path === '/resellers/4/ledger' && init?.method === 'POST') {
        throw new ApiRequestError('The ISP owes the reseller 0.00', 422, { error: { code: 'PAYOUT_EXCEEDS_OWED', message: 'The ISP owes the reseller 0.00' } });
      }
      throw new Error(`unexpected ${path}`);
    });
    await i18n.changeLanguage('es');
    try {
      wrapRouter(<ResellerLedgerTab />);
      const user = userEvent.setup();
      await screen.findByRole('option', { name: 'Punto Norte' });
      await user.selectOptions(screen.getByLabelText('Revendedor'), '4');
      const row = (await screen.findByText('Comisión')).closest('tr')!;
      expect(within(row).getByText('Factura F-0811')).toBeInTheDocument();
      expect(within(row).queryByRole('link', { name: 'Factura F-0811' })).not.toBeInTheDocument();
      const payout = screen.getByRole('form', { name: 'Registrar pago al revendedor' });
      await user.type(within(payout).getByLabelText('Monto pagado'), '38.79');
      await user.click(within(payout).getByRole('button', { name: 'Registrar pago' }));
      expect(await within(payout).findByRole('alert')).toHaveTextContent('Un pago no puede ser mayor a lo que la empresa le debe al revendedor.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('is a ResellerPage tab only with reseller_ledger.view', () => {
    mocks.apiFetch.mockImplementation(async () => ({ data: [], meta: { total: 0, page: 1, limit: 25 } }));
    const { unmount } = wrap(<ResellerPage />);
    expect(screen.getByRole('button', { name: 'Movements' })).toBeInTheDocument();
    unmount();
    mocks.permissions = ['resellers.view'];
    wrap(<ResellerPage />);
    expect(screen.queryByRole('button', { name: 'Movements' })).not.toBeInTheDocument();
  });
});

describe('ResellerCommissionsTab', () => {
  const PAGE = {
    data: [
      {
        id: 2, reseller_id: 4, invoice_id: 812, invoice_number: 'F-0812', client_id: 32, client_name: 'Beto Ruiz',
        commission_rate: 10, base_amount: 300, invoice_total: 348, commission_amount: 30, currency: 'MXN',
        status: 'reversed', earned_at: '2026-11-05T17:00:00Z', reversed_at: '2026-11-06T17:00:00Z', created_at: '2026-11-05T17:00:00Z',
      },
      {
        id: 1, reseller_id: 4, invoice_id: 811, invoice_number: 'F-0811', client_id: 31, client_name: 'Ana López',
        commission_rate: 10, base_amount: 387.93, invoice_total: 450, commission_amount: 38.79, currency: 'MXN',
        status: 'earned', earned_at: '2026-11-07T17:00:00Z', reversed_at: null, created_at: '2026-11-07T17:00:00Z',
      },
    ],
    summary: { earned: 38.79, reversed: 30, earned_this_month: 38.79 },
    meta: { total: 2, page: 1, limit: 25 },
  };
  const wrapRouter = (ui: ReactNode) => wrap(<MemoryRouter>{ui}</MemoryRouter>);

  beforeEach(() => {
    mocks.permissions = ['resellers.view', 'reseller_commissions.view', 'invoices.view'];
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
      if (path.startsWith('/resellers/4/commissions?')) return PAGE;
      throw new Error(`unexpected ${path}`);
    });
  });

  it('lists a top-level reseller\'s commissions with base, rate, amount and status', async () => {
    wrapRouter(<ResellerCommissionsTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByText('Earned this month').parentElement).toHaveTextContent('$38.79');
    expect(within(summary).getByText('Reversed').parentElement).toHaveTextContent('$30.00');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers/4/commissions?page=1&limit=25');

    const earned = screen.getByText('Ana López').closest('tr')!;
    expect(within(earned).getByRole('link', { name: 'F-0811' })).toHaveAttribute('href', '/invoices/811');
    expect(earned).toHaveTextContent('$387.93');
    expect(earned).toHaveTextContent('10%');
    expect(earned).toHaveTextContent('$38.79');
    expect(earned).toHaveTextContent('Earned');
    const reversed = screen.getByText('Beto Ruiz').closest('tr')!;
    expect(reversed).toHaveTextContent('Reversed');
    expect(reversed).toHaveTextContent(/Reversed 6 nov 2026/i);
    // Nothing is approved or paid by hand any more.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('filters by status and names the invoice without a link without invoices.view', async () => {
    mocks.permissions = ['resellers.view', 'reseller_commissions.view'];
    wrapRouter(<ResellerCommissionsTab />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Punto Norte' });
    await user.selectOptions(screen.getByLabelText('Reseller'), '4');
    await screen.findByText('Ana López');
    expect(screen.queryByRole('link', { name: 'F-0811' })).not.toBeInTheDocument();
    expect(screen.getByText('F-0811')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'reversed');
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledWith('/resellers/4/commissions?status=reversed&page=1&limit=25'));
  });

  it('is a ResellerPage tab only with reseller_commissions.view', () => {
    mocks.apiFetch.mockImplementation(async () => ({ data: [], meta: { total: 0, page: 1, limit: 25 } }));
    const { unmount } = wrap(<ResellerPage />);
    expect(screen.getByRole('button', { name: 'Commissions' })).toBeInTheDocument();
    unmount();
    mocks.permissions = ['resellers.view'];
    wrap(<ResellerPage />);
    expect(screen.queryByRole('button', { name: 'Commissions' })).not.toBeInTheDocument();
  });
});
