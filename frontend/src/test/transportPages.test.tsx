// =============================================================================
// FE-24 — risky pages through the real transport, with server-shaped data
// =============================================================================
// 122 of 159 page tests mocked '@/api/client' wholesale (most with a token
// always present), so no page test ran the token attach, the refresh on 401
// or the retry, and fixtures were not what mysql2 sends. Here only fetch is
// stubbed (fakeServer): the pages use the real client.ts and
// PortalAuthContext. Covered: a session with no in-memory token (a reload)
// that refreshes and retries; a role the server refuses (403); DECIMAL
// strings and UTC-midnight DATEs, under TZ=America/Mexico_City
// (vite.config.ts), where a UTC-midnight date read as local time is the day
// before.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { fakeServer } from './fakeServer';
import { tokenStore } from '@/api/client';
import { portalTokenStore } from '@/auth/PortalAuthContext';

// openapi-fetch keeps the fetch it was created with, at import time, so a
// stub installed later never reaches api.GET. A delegate goes in first and
// each test points it at its fake server.
const transport = vi.hoisted(() => {
  const holder: { fetch: typeof fetch } = { fetch: () => Promise.reject(new Error('no fake server')) };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => holder.fetch(input, init)) as typeof fetch;
  // A browser resolves new Request('/api/v1/…') against the page; Node's
  // Request does not, and openapi-fetch builds one for every call.
  const NodeRequest = globalThis.Request;
  globalThis.Request = class extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin) : input, init);
    }
  } as typeof Request;
  return holder;
});
const auth = vi.hoisted(() => ({ user: { id: 1, role: 'billing', permissions: ['invoice_settings.view', 'invoice_settings.update'] as string[], organization_currency: 'MXN' } }));
vi.mock('@/auth/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/auth/AuthContext')>()),
  useAuth: () => ({ user: auth.user }),
}));

import { TaxReports } from '@/pages/TaxReports';
import { InvoiceSettings } from '@/pages/InvoiceSettings';
import { PortalInvoiceDetail } from '@/pages/portal/PortalInvoiceDetail';
import { RecordPaymentModal } from '@/components/RecordPaymentModal';

function wrap(node: ReactNode, path = '/', route = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={route} element={node} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  tokenStore.clear();
  portalTokenStore.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the tests run in a Mexican time zone', () => {
  it('TZ is America/Mexico_City', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Mexico_City');
  });
});

describe('TaxReports', () => {
  it('after a reload (no in-memory token) refreshes once, retries, and downloads the server\'s file', async () => {
    server = fakeServer();
    server.on('GET /api/v1/billing/tax-reports', req => ({
      body: `invoice_number,total\nINV-1,580.00\n# ${req.query.get('from')}..${req.query.get('to')}`,
      headers: { 'Content-Disposition': 'attachment; filename="impuestos-2026.csv"' },
    }));
    transport.fetch = server.fetch as unknown as typeof fetch;
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });

    const user = userEvent.setup();
    wrap(<TaxReports />);
    await user.clear(screen.getByLabelText('From'));
    await user.type(screen.getByLabelText('From'), '2026-01-01');
    await user.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(clicked).toEqual(['impuestos-2026.csv']));
    const calls = server.requests('GET /api/v1/billing/tax-reports');
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('Authorization')).toBeNull();
    expect(calls[1].headers.get('Authorization')).toBe(`Bearer ${server.token}`);
    expect(server.requests('POST /api/v1/auth/refresh')).toHaveLength(1);
    expect(calls[1].query.get('from')).toBe('2026-01-01');
    expect(await created[0].text()).toContain('INV-1,580.00');
  });

  it('shows an error when the session is gone (refresh refused twice)', async () => {
    server = fakeServer();
    server.on('GET /api/v1/billing/tax-reports', { body: 'x' });
    server.denyRefresh();
    transport.fetch = server.fetch as unknown as typeof fetch;
    const user = userEvent.setup();
    wrap(<TaxReports />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/401/, {}, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('InvoiceSettings', () => {
  it('loads with a reload-refresh, then saves with the new token', async () => {
    server = fakeServer();
    server.on('GET /api/v1/invoice-settings', { body: { id: 3, organization_id: 1, logo_url: null, header_color: '#1a5276', footer_legal: 'RFC EKU9003173C9', payment_instructions: null } });
    server.on('PUT /api/v1/invoice-settings', req => ({ body: { id: 3, ...(req.body as object) } }));
    transport.fetch = server.fetch as unknown as typeof fetch;
    const user = userEvent.setup();
    wrap(<InvoiceSettings />);

    expect(await screen.findByDisplayValue('RFC EKU9003173C9')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Logo URL'), 'https://isp.example/logo.png');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();

    const [put] = server.requests('PUT /api/v1/invoice-settings');
    expect(put.headers.get('Authorization')).toBe(`Bearer ${server.token}`);
    expect(put.body).toMatchObject({ logo_url: 'https://isp.example/logo.png', footer_legal: 'RFC EKU9003173C9' });
    expect(server.requests('POST /api/v1/auth/refresh')).toHaveLength(1);
  });

  it('a role the server refuses sees the load error and cannot save', async () => {
    auth.user = { id: 2, role: 'readonly', permissions: [], organization_currency: 'MXN' };
    server = fakeServer();
    server.on('GET /api/v1/invoice-settings', { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Required permission: invoice_settings.view' } } });
    transport.fetch = server.fetch as unknown as typeof fetch;
    tokenStore.setAccess(server.token);
    wrap(<InvoiceSettings />);
    expect(await screen.findByText(/Failed to load data/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(server.requests('POST /api/v1/auth/refresh')).toHaveLength(0);
    auth.user = { id: 1, role: 'billing', permissions: ['invoice_settings.view', 'invoice_settings.update'], organization_currency: 'MXN' };
  });
});

describe('PortalInvoiceDetail', () => {
  const invoice = {
    id: 7, invoice_number: 'INV-000007', subtotal: '500.00', tax_amount: '80.00', discount_amount: null,
    total: '580.00', currency: 'MXN', period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-10-31T00:00:00.000Z',
    due_date: '2026-11-15T00:00:00.000Z', paid_at: null, status: 'issued', notes: null,
    created_at: '2026-11-01T06:00:00.000Z', balance_due: 580, pending_checkout: 0, has_cfdi: 0,
    items: [{ id: 1, description: 'Internet 100 Mbps', quantity: '1.00', unit_price: '500.00', amount: '500.00', tax_rate: '0.1600' }],
    payments: [],
  };

  it('a subscriber after a reload refreshes, sees the due date as the 15th, and starts a payment', async () => {
    server = fakeServer({ refreshPath: '/api/v1/portal/auth/refresh' });
    server.on('GET /api/v1/portal/invoices/7', { body: { data: invoice } });
    server.on('POST /api/v1/portal/invoices/7/pay', { body: { data: { payment_url: 'https://pay.example/session/1' } } });
    transport.fetch = server.fetch as unknown as typeof fetch;
    portalTokenStore.markSession();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, href: 'http://localhost/portal/invoices/7', origin: 'http://localhost' });

    const user = userEvent.setup();
    wrap(<PortalInvoiceDetail />, '/portal/invoices/7', '/portal/invoices/:id');
    expect((await screen.findAllByText(/INV-000007/)).length).toBeGreaterThan(0);
    // A UTC-midnight DATE is the 15th in Mexico, not the 14th.
    expect(screen.getByText(/2026-11-15/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-11-14/)).toBeNull();
    expect(screen.getAllByText(/580\.00/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /pay now/i }));
    await waitFor(() => expect(server.requests('POST /api/v1/portal/invoices/7/pay')).toHaveLength(1));
    const [pay] = server.requests('POST /api/v1/portal/invoices/7/pay');
    expect(pay.headers.get('Authorization')).toBe(`Bearer ${server.token}`);
    expect(pay.body).toEqual({ return_url: 'http://localhost/portal/invoices/7' });
    expect(server.requests('POST /api/v1/portal/auth/refresh')).toHaveLength(1);
  });
});

describe('RecordPaymentModal', () => {
  it('lists a client\'s open invoices from DECIMAL strings and posts the payment with the token', async () => {
    server = fakeServer();
    server.on('GET /api/v1/clients/10/open-invoices', { body: { data: [
      { id: 21, invoice_number: 'INV-000021', total: '580.00', balance_due: '580.00', currency: 'MXN', status: 'issued', issue_date: '2026-11-01T00:00:00.000Z', due_date: '2026-11-15T00:00:00.000Z' },
    ] } });
    server.on('POST /api/v1/payments', req => ({ status: 201, body: { data: { id: 99, ...(req.body as object) } } }));
    server.on('POST /api/v1/payments/99/allocate-auto', { body: { data: { allocations: [{ invoice_id: 21, amount: '580.00' }], remainder: '0.00' } } });
    transport.fetch = server.fetch as unknown as typeof fetch;
    tokenStore.setAccess(server.token);
    const onRecorded = vi.fn();
    const user = userEvent.setup();
    wrap(<RecordPaymentModal lockedClientId={10} lockedClientName="Alice" onClose={vi.fn()} onRecorded={onRecorded} />);

    expect(await screen.findByText(/INV-000021/)).toBeInTheDocument();
    expect(screen.getAllByText(/580\.00/).length).toBeGreaterThan(0);
    // The amount is pre-filled from the invoice's DECIMAL-string balance.
    await waitFor(() => expect(Number((screen.getByLabelText(/^amount/i) as HTMLInputElement).value)).toBe(580));
    await user.click(screen.getByRole('button', { name: /record payment/i }));
    await waitFor(() => expect(server.requests('POST /api/v1/payments')).toHaveLength(1));
    const [post] = server.requests('POST /api/v1/payments');
    expect(post.headers.get('Authorization')).toBe(`Bearer ${server.token}`);
    expect(post.body).toMatchObject({ client_id: 10, currency: 'MXN' });
    expect(Number((post.body as { amount: unknown }).amount)).toBe(580);
  });
});
