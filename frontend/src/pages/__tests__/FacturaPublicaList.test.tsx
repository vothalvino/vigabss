// =============================================================================
// VigaBSS 5.0 — Facturas globales page tests
// =============================================================================
// The page used to be read-only: a factura global could only be built and
// stamped through the API. Staff now create one for a period, add the
// period's eligible invoices (all at once or one by one), remove one from a
// draft and stamp it.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { FacturaPublicaList } from '../FacturaPublicaList';

const mocks = vi.hoisted(() => ({
  GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(),
  permissions: ['facturas_publicas.view', 'facturas_publicas.create', 'facturas_publicas.update', 'cfdi_documents.create'] as string[],
}));
vi.mock('@/api/client', () => ({
  api: { GET: mocks.GET, POST: mocks.POST, DELETE: mocks.DELETE },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'billing', permissions: mocks.permissions } }),
}));

const draft = {
  id: 1, periodicidad: '04', meses: '10', anio: 2026,
  subtotal: null, total_impuestos: null, total: null, status: 'draft', cfdi_document_id: null,
};
const stamped = { ...draft, id: 2, status: 'stamped', cfdi_document_id: 900, subtotal: '1000.00', total_impuestos: '160.00', total: '1160.00' };

const page = <T,>(data: T[], extra: Record<string, unknown> = {}) => ({
  data: { data, meta: { total: data.length, page: 1, limit: 50, totalPages: 1, ...extra } }, error: undefined,
});

let linked: Record<string, unknown>[];
let eligible: Record<string, unknown>[];

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FacturaPublicaList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

async function openDraft() {
  renderList();
  const row = (await screen.findByText('#1')).closest('tr') as HTMLElement;
  await userEvent.click(within(row).getByRole('button', { name: t('facturaGlobal.open') }));
  return screen.findByRole('region', { name: t('facturaGlobal.detailTitle', { id: 1, period: '10/2026' }) });
}

describe('Facturas globales page', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.permissions = ['facturas_publicas.view', 'facturas_publicas.create', 'facturas_publicas.update', 'cfdi_documents.create'];
    linked = [];
    eligible = [
      { id: 11, invoice_number: 'INV-11', total: '116.00', currency: 'MXN', paid_at: '2026-10-05T18:00:00Z' },
      { id: 12, invoice_number: 'INV-12', total: '232.00', currency: 'MXN', paid_at: '2026-10-06T18:00:00Z' },
    ];
    mocks.GET.mockImplementation((path: string) => {
      if (path === '/facturas-publicas') return Promise.resolve(page([draft, stamped]));
      if (path === '/facturas-publicas/{id}/items') return Promise.resolve(page(linked));
      if (path === '/facturas-publicas/{id}/eligible-invoices') {
        return Promise.resolve(page(eligible, { byCurrency: [{ currency: 'MXN', count: eligible.length, total: '348.00' }] }));
      }
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    mocks.POST.mockResolvedValue({ data: { data: {} }, error: undefined });
    mocks.DELETE.mockResolvedValue({ data: undefined, error: undefined });
  });

  it('lists facturas with their periodicity and month names', async () => {
    renderList();
    expect(await screen.findByText(t('facturaGlobal.title'))).toBeInTheDocument();
    expect(await screen.findAllByText('04 · Monthly')).toHaveLength(2);
    expect(screen.getAllByText('10 · October')).toHaveLength(2);
  });

  it('shows the empty message when there are none', async () => {
    mocks.GET.mockImplementation(() => Promise.resolve(page([])));
    renderList();
    expect(await screen.findByText(t('facturaGlobal.empty'))).toBeInTheDocument();
  });

  it('creates a factura for a period and opens it', async () => {
    mocks.POST.mockImplementation((path: string) => (path === '/facturas-publicas'
      ? Promise.resolve({ data: { data: { ...draft, id: 3, meses: '13', periodicidad: '05' } }, error: undefined })
      : Promise.resolve({ data: { data: {} }, error: undefined })));
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: t('facturaGlobal.new') }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText(t('facturaGlobal.periodicidad')), '05');
    // A bimestral global reports Meses 13-18: the month choices follow.
    expect(within(dialog).getByLabelText(t('facturaGlobal.meses'))).toHaveValue('13');
    const year = within(dialog).getByLabelText(t('facturaGlobal.anio'));
    await userEvent.clear(year);
    await userEvent.type(year, '2026');
    await userEvent.click(within(dialog).getByRole('button', { name: t('facturaGlobal.create') }));

    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/facturas-publicas', {
      body: { periodicidad: '05', meses: '13', anio: 2026 },
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the server\'s reason when a period is refused', async () => {
    mocks.POST.mockResolvedValue({ data: undefined, error: { error: { message: 'InformacionGlobal: Año must be a year from 2022' } } });
    renderList();
    await userEvent.click(await screen.findByRole('button', { name: t('facturaGlobal.new') }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t('facturaGlobal.create') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Año must be a year from 2022');
  });

  it('adds every eligible invoice of the period in one action', async () => {
    mocks.POST.mockResolvedValue({ data: { data: { added: 2 } }, error: undefined });
    const detail = await openDraft();
    await userEvent.click(await within(detail).findByRole('button', { name: /Add all 2/ }));

    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/facturas-publicas/{id}/items/add-eligible', {
      params: { path: { id: 1 } }, body: { currency: 'MXN' },
    }));
    expect(await within(detail).findByRole('status')).toHaveTextContent(t('facturaGlobal.added', { count: 2 }));
  });

  it('adds one invoice and removes a linked one', async () => {
    linked = [{ id: 40, invoice_id: 10, invoice_number: 'INV-10', total: '58.00', currency: 'MXN', paid_at: '2026-10-02T18:00:00Z' }];
    const detail = await openDraft();
    const inv11 = (await within(detail).findByText('INV-11')).closest('tr') as HTMLElement;
    await userEvent.click(within(inv11).getByRole('button', { name: t('facturaGlobal.add') }));
    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/facturas-publicas/{id}/items', {
      params: { path: { id: 1 } }, body: { invoice_id: 11 },
    }));

    const inv10 = within(detail).getByText('INV-10').closest('tr') as HTMLElement;
    await userEvent.click(within(inv10).getByRole('button', { name: t('facturaGlobal.remove') }));
    await waitFor(() => expect(mocks.DELETE).toHaveBeenCalledWith('/facturas-publicas/{id}/items/{itemId}', {
      params: { path: { id: 1, itemId: 40 } },
    }));
  });

  it('stamps a draft after confirming, and says when the PAC is still pending', async () => {
    linked = [{ id: 40, invoice_id: 10, invoice_number: 'INV-10', total: '58.00', currency: 'MXN', paid_at: '2026-10-02T18:00:00Z' }];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.POST.mockResolvedValue({ data: { data: { stamped: false, cfdi_document_id: 900 } }, error: undefined });
    const detail = await openDraft();
    await userEvent.click(await within(detail).findByRole('button', { name: t('facturaGlobal.stamp') }));

    await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith('/facturas-publicas/{id}/stamp', { params: { path: { id: 1 } } }));
    expect(await within(detail).findByRole('status')).toHaveTextContent(t('facturaGlobal.stampPending', { id: 900 }));
  });

  it('cannot stamp an empty draft', async () => {
    const detail = await openDraft();
    expect(await within(detail).findByRole('button', { name: t('facturaGlobal.stamp') })).toBeDisabled();
  });

  it('a stamped factura is read-only', async () => {
    linked = [{ id: 41, invoice_id: 20, invoice_number: 'INV-20', total: '1160.00', currency: 'MXN', paid_at: '2026-10-02T18:00:00Z' }];
    renderList();
    const row = (await screen.findByText('#2')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: t('facturaGlobal.open') }));
    const detail = await screen.findByRole('region', { name: t('facturaGlobal.detailTitle', { id: 2, period: '10/2026' }) });
    expect(await within(detail).findByText('INV-20')).toBeInTheDocument();
    expect(within(detail).getByText(t('facturaGlobal.frozen'))).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: t('facturaGlobal.remove') })).toBeNull();
    expect(within(detail).queryByRole('button', { name: t('facturaGlobal.stamp') })).toBeNull();
    expect(mocks.GET).not.toHaveBeenCalledWith('/facturas-publicas/{id}/eligible-invoices', expect.objectContaining({ params: expect.objectContaining({ path: { id: 2 } }) }));
  });

  it('hides the create, edit and stamp actions without their permissions', async () => {
    mocks.permissions = ['facturas_publicas.view'];
    const detail = await openDraft();
    expect(screen.queryByRole('button', { name: t('facturaGlobal.new') })).toBeNull();
    expect(await within(detail).findByText('INV-11')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: t('facturaGlobal.add') })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Add all/ })).toBeNull();
    expect(within(detail).queryByRole('button', { name: t('facturaGlobal.stamp') })).toBeNull();
  });
});
