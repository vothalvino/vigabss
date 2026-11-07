// =============================================================================
// Reseller administration: create/edit form, allowed plans, create login
// =============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import ResellerPage from '../ResellerPage';
import { ResellerFormModal } from '../resellers/ResellerFormModal';
import { ResellerAllowedPlansTab } from '../resellers/ResellerAllowedPlansTab';
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
  useAuth: () => ({ user: { id: 1, role: 'manager', permissions: mocks.permissions } }),
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
      if (path === '/resellers?parent_id=null&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
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
      if (path === '/resellers?parent_id=null&limit=100') return { data: [] };
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
      if (path === '/resellers?parent_id=null&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
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
    mocks.GET.mockImplementation((path: string) => {
      if (path === '/resellers') return ok([{ id: 4, name: 'Punto Norte' }]);
      return ok([]);
    });
    mocks.apiFetch.mockResolvedValue({ data: { user_id: 50, email: 'caja@example.com', reseller_id: 4 } });
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
    mocks.apiFetch.mockRejectedValue(new ApiRequestError('Password must be at least 10 characters', 422));
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
