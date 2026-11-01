// FE-07: nine of the thirteen portal pages hard-coded English, so a subscriber
// with Spanish or Portuguese selected still read "Pay Now", "Invoice not
// found." and "📤 Issued" on the invoice, payment, ticket and account pages.
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/i18n';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/auth/PortalAuthContext', () => ({
  portalAuthedFetch: (...a: unknown[]) => mocks.fetch(...a),
  usePortalAuth: () => ({ client: { id: 10, name: 'Ana' } }),
}));

import { PortalInvoiceDetail } from '../PortalInvoiceDetail';
import { PortalInvoices } from '../PortalInvoices';
import { PortalTickets } from '../PortalTickets';
import { PortalAccount } from '../PortalAccount';

const INVOICE = {
  id: 1, invoice_number: 'F-1', subtotal: '431.03', tax_amount: '68.97', total: '500.00', currency: 'MXN',
  period_start: null, period_end: null, due_date: '2026-10-20', paid_at: null, status: 'overdue', notes: null,
  created_at: '2026-10-01T00:00:00.000Z', balance_due: 500, pending_checkout: false, has_cfdi: false, items: [], payments: [],
};
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderAt(url: string, path: string, element: ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path={path} element={element} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('portal pages follow the selected language', () => {
  beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage('es'); });
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('the invoice page and its Pay button are in Spanish', async () => {
    mocks.fetch.mockResolvedValue(json({ data: INVOICE }));
    renderAt('/portal/invoices/1', '/portal/invoices/:id', <PortalInvoiceDetail />);
    expect(await screen.findByRole('button', { name: 'Pagar ahora' })).toBeInTheDocument();
    expect(screen.getByText('VENCIDA')).toBeInTheDocument();
    expect(screen.getByText(/Volver a facturas/)).toBeInTheDocument();
    expect(screen.queryByText(/Pay Now|Back to invoices/)).toBeNull();
  });

  it('a missing invoice says so in Spanish', async () => {
    mocks.fetch.mockResolvedValue(json({}, 404));
    renderAt('/portal/invoices/9', '/portal/invoices/:id', <PortalInvoiceDetail />);
    expect(await screen.findByText('Factura no encontrada.')).toBeInTheDocument();
  });

  it('the invoice list labels statuses in Spanish', async () => {
    mocks.fetch.mockResolvedValue(json({ data: [{ ...INVOICE, status: 'issued' }], meta: { page: 1, limit: 20, total: 1, pages: 1 } }));
    renderAt('/portal/invoices', '/portal/invoices', <PortalInvoices />);
    expect(await screen.findByText('📤 Emitida')).toBeInTheDocument();
    expect(screen.queryByText(/Issued/)).toBeNull();
  });

  it('the ticket list and the account page are in Spanish', async () => {
    mocks.fetch.mockResolvedValue(json({ data: [], meta: { page: 1, limit: 20, total: 0, pages: 0 } }));
    const { unmount } = renderAt('/portal/tickets', '/portal/tickets', <PortalTickets />);
    expect(await screen.findByRole('button', { name: '+ Nuevo ticket' })).toBeInTheDocument();
    unmount();
    mocks.fetch.mockResolvedValue(json({ data: [] }));
    renderAt('/portal/account', '/portal/account', <PortalAccount />);
    expect(await screen.findByRole('heading', { name: 'Configuración de la Cuenta' })).toBeInTheDocument();
  });
});
