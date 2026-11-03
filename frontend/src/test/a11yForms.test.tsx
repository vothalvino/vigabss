// =============================================================================
// FE-22 — axe on the money and ticket modals and the portal invoice pages
// =============================================================================
// The axe suite (a11y.test.tsx) covered list pages; none of the forms where
// staff record money or subscribers pay. Their labels were not tied to the
// fields (label rule), so they are checked here too. color-contrast is off:
// jsdom computes no CSS.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { configureAxe } from 'jest-axe';

const axe = configureAxe({
  rules: { 'color-contrast': { enabled: false } },
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const mocks = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), portalFetch: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: { GET: (...a: unknown[]) => mocks.get(...a), POST: vi.fn(), PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
  authedFetch: (...a: unknown[]) => mocks.fetch(...a),
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
vi.mock('@/auth/PortalAuthContext', () => ({
  portalAuthedFetch: (...a: unknown[]) => mocks.portalFetch(...a),
  usePortalAuth: () => ({ client: { id: 10, name: 'Alice' }, loading: false, initialized: true, logout: vi.fn() }),
}));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin', permissions: [], organization_currency: 'MXN' } }),
}));

import { RecordPaymentModal } from '@/components/RecordPaymentModal';
import { GenerateInvoiceModal } from '@/components/GenerateInvoiceModal';
import { NewTicketModal } from '@/components/NewTicketModal';
import { CreditNoteModal } from '@/pages/CreditNoteList';
import { PortalInvoices } from '@/pages/portal/PortalInvoices';
import { PortalInvoiceDetail } from '@/pages/portal/PortalInvoiceDetail';

const INVOICE = {
  id: 7, invoice_number: 'INV-000007', subtotal: '500.00', tax_amount: '80.00', discount_amount: null,
  total: '580.00', currency: 'MXN', period_start: '2026-10-01', period_end: '2026-10-31',
  due_date: '2026-11-15', paid_at: null, status: 'issued', notes: null, created_at: '2026-11-01T00:00:00Z',
  balance_due: 580, items: [{ id: 1, description: 'Internet 100 Mbps', quantity: '1.00', unit_price: '500.00', amount: '500.00', tax_rate: '0.1600' }],
  payments: [],
};

function wrap(node: ReactNode, path = '/', route = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path={route} element={node} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function expectNoViolations(container: HTMLElement) {
  const results = await axe(container);
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

describe('accessibility of forms and portal invoice pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ data: { data: [], meta: { total: 0 } }, error: undefined });
    mocks.fetch.mockResolvedValue(json({ data: [] }));
    mocks.portalFetch.mockImplementation(async (url: string) => (
      /\/invoices\/7$/.test(url) ? json({ data: INVOICE }) : json({ data: [INVOICE], meta: { total: 1, page: 1, limit: 20, pages: 1 } })
    ));
  });

  it('RecordPaymentModal', async () => {
    const { container } = wrap(<RecordPaymentModal lockedClientId={10} lockedClientName="Alice" onClose={vi.fn()} onRecorded={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await expectNoViolations(container);
  });

  it('GenerateInvoiceModal', async () => {
    const { container } = wrap(<GenerateInvoiceModal lockedClientId={10} lockedClientName="Alice" onClose={vi.fn()} onGenerated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await expectNoViolations(container);
  });

  it('CreditNoteModal', async () => {
    const { container } = wrap(<CreditNoteModal creditNote={null} lockedClientId={10} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await expectNoViolations(container);
  });

  it('NewTicketModal', async () => {
    const { container } = wrap(<NewTicketModal lockedClientId={10} lockedClientName="Alice" onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    await expectNoViolations(container);
  });

  it('PortalInvoices', async () => {
    const { container } = wrap(<PortalInvoices />, '/portal/invoices', '/portal/invoices');
    await waitFor(() => expect(screen.getAllByText('INV-000007').length).toBeGreaterThan(0));
    await expectNoViolations(container);
  });

  it('PortalInvoiceDetail with the pay action', async () => {
    const { container } = wrap(<PortalInvoiceDetail />, '/portal/invoices/7', '/portal/invoices/:id');
    await waitFor(() => expect(screen.getAllByText(/INV-000007/).length).toBeGreaterThan(0));
    await expectNoViolations(container);
  });
});
