// FE-14: back from the payment provider the invoice still read ISSUED (the
// webhook lands later) and offered Pay Now again, each click opening a new
// checkout; the CFDI button always showed and saved a 404 body as the XML.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/auth/PortalAuthContext', () => ({ portalAuthedFetch: (...a: unknown[]) => mocks.fetch(...a) }));

import { PortalInvoiceDetail } from '../PortalInvoiceDetail';

const INVOICE = {
  id: 1, invoice_number: 'F-1', subtotal: '431.03', tax_amount: '68.97', total: '500.00', currency: 'MXN',
  period_start: null, period_end: null, due_date: '2026-10-20', paid_at: null, status: 'overdue', notes: null,
  created_at: '2026-10-01T00:00:00.000Z', balance_due: 500, pending_checkout: false, has_cfdi: false, items: [], payments: [],
};
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, blob: async () => new Blob(['x']) }) as unknown as Response;

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/portal/invoices/:id" element={<PortalInvoiceDetail />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PortalInvoiceDetail payment flow', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('after a successful checkout it confirms instead of offering Pay Now again', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { ...INVOICE, pending_checkout: true } }));
    renderAt('/portal/invoices/1?payment=success');
    expect(await screen.findByText(/confirming your payment/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay Now|Continue payment/ })).toBeNull();
  });

  it('an open checkout is continued, not duplicated', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { ...INVOICE, pending_checkout: true } }));
    renderAt('/portal/invoices/1');
    expect(await screen.findByRole('button', { name: 'Continue payment' })).toBeInTheDocument();
  });

  it('Pay another way asks first, then opens a fresh checkout that withdraws the started one', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, origin: 'https://portal.example.com', set href(v: string) { assign(v); } }, writable: true });
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? json({ data: { payment_url: 'https://checkout.example.com/new' } }, 201)
      : json({ data: { ...INVOICE, pending_checkout: true } })));
    const user = userEvent.setup();
    renderAt('/portal/invoices/1');

    await user.click(await screen.findByRole('button', { name: 'Pay another way' }));
    // Nothing is cancelled until the warning about the voucher is accepted.
    expect(screen.getByText(/OXXO voucher/)).toBeInTheDocument();
    expect(mocks.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Cancel it and choose again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.example.com/new'));
    const post = mocks.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toMatch(/\/invoices\/1\/pay$/);
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({ fresh: true });
  });

  it('Pay another way is only offered while a checkout is open', async () => {
    mocks.fetch.mockResolvedValue(json({ data: INVOICE }));
    renderAt('/portal/invoices/1');
    expect(await screen.findByRole('button', { name: 'Pay Now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay another way' })).toBeNull();
  });

  it('a cancelled checkout says so and offers to try again', async () => {
    mocks.fetch.mockResolvedValue(json({ data: INVOICE }));
    renderAt('/portal/invoices/1?payment=cancelled');
    expect(await screen.findByText(/not completed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay Now' })).toBeInTheDocument();
  });

  it('the CFDI button only appears when a stamped CFDI exists', async () => {
    mocks.fetch.mockResolvedValue(json({ data: INVOICE }));
    renderAt('/portal/invoices/1');
    await screen.findByRole('button', { name: 'Download PDF' });
    expect(screen.queryByRole('button', { name: 'Download CFDI XML' })).toBeNull();
  });

  it('a failed download shows an error instead of saving the error body', async () => {
    mocks.fetch.mockImplementation(async (url: string) => (String(url).endsWith('/pdf') ? json({ error: 'nope' }, 404) : json({ data: INVOICE })));
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }));
    renderAt('/portal/invoices/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(screen.getByText(/not available right now/)).toBeInTheDocument());
    expect(createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
