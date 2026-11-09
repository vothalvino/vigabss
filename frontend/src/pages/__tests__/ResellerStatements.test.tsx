// Reseller statements (phase 5): the staff "Statements" tab of /resellers and
// the statements section of the reseller app's Mi caja.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { ApiRequestError } from '@/api/apiFetch';
import { ResellerStatementsTab } from '../resellers/ResellerStatementsTab';
import { PuntoCash } from '../punto/PuntoCash';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  authedFetch: vi.fn(),
  user: null as unknown,
}));
vi.mock('@/api/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/apiFetch')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/api/client', () => ({ authedFetch: mocks.authedFetch, api: {} }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }));

const TOTALS = {
  collection: 1000, collection_void: -50, bag_sealed: -600, deposit: -300,
  commission: -95.5, commission_reversal: 20, payout: 15.5, adjustment: 10,
};
const statement = (over: Record<string, unknown> = {}) => ({
  id: 7, reseller_id: 4, reseller_name: 'Punto Norte', period_start: '2026-10-01', period_end: '2026-10-31',
  currency: 'MXN', opening_balance: 500, totals: TOTALS, closing_balance: 500, entry_count: 8,
  sweep_earned: 1, sweep_reversed: 0, status: 'draft', generated_by: 1, generated_at: '2026-11-08T10:00:00Z',
  approved_by: null, approved_at: null, settled_by: null, settled_at: null, bank_ref: null,
  settlement_entry_id: null, voided_at: null, notes: null, ...over,
});
const LINES = [
  { id: 11, entry_type: 'collection', amount: 1000, note: null, created_at: '2026-10-03T16:00:00Z', payment_id: 101, invoice_id: null, invoice_number: null, cash_bag_serial: null },
  { id: 12, entry_type: 'commission', amount: -95.5, note: 'Comisión 10%', created_at: '2026-10-08T16:00:00Z', payment_id: null, invoice_id: 811, invoice_number: 'F-0811', cash_bag_serial: null },
];

let current = statement();
type Handler = (path: string, init?: RequestInit) => unknown;
let override: Handler | null = null;

function staffRespond(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? 'GET';
  if (override) {
    const r = override(path, init);
    if (r !== undefined) return r;
  }
  if (path === '/resellers?parent_id=null&page=1&limit=100') return { data: [{ id: 4, name: 'Punto Norte' }] };
  if (path.startsWith('/resellers/4/settlements?')) {
    return { data: [current], meta: { total: 1, page: 1, limit: 12, default_period: { period_start: '2026-10-01', period_end: '2026-10-31' } } };
  }
  if (path === '/resellers/4/settlements' && method === 'POST') return { data: statement({ id: 8 }), sweep: { earned: 2, restored: 1, reversed: 1, failed: 0, truncated: false } };
  if (path.startsWith('/resellers/4/settlements/7?')) return { data: current, lines: LINES, meta: { total: 2, page: 1, limit: 50 } };
  if (path.startsWith('/resellers/4/settlements/8?')) return { data: statement({ id: 8 }), lines: [], meta: { total: 0, page: 1, limit: 50 } };
  if (/^\/resellers\/4\/settlements\/7\/(approve|regenerate|discard|settle)$/.test(path) && method === 'POST') return { data: current };
  throw new Error(`unexpected ${method} ${path}`);
}

const calls = (method: string, path: string) =>
  mocks.apiFetch.mock.calls.filter(([p, init]) => p === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
const wrap = (ui: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
  current = statement();
  override = null;
  mocks.user = {
    id: 1, role: 'manager', organization_currency: 'MXN',
    permissions: ['resellers.view', 'reseller_settlements.view', 'reseller_settlements.manage', 'reseller_settlements.approve', 'invoices.view'],
  };
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => staffRespond(path, init));
});
afterEach(async () => { await i18n.changeLanguage('en'); });

async function openReseller() {
  const user = userEvent.setup();
  wrap(<ResellerStatementsTab />);
  await screen.findByRole('option', { name: 'Punto Norte' });
  await user.selectOptions(screen.getByLabelText('Reseller'), '4');
  await screen.findByText('2026-10-01 to 2026-10-31');
  return user;
}

describe('ResellerStatementsTab', () => {
  it('lists the statements and generates one for last month, reporting the commission check', async () => {
    const user = await openReseller();
    expect(screen.getByText('The reseller owes $500.00')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-31');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft statement generated. Commission check: 3 booked, 1 reversed.');
    expect(JSON.parse(String((calls('POST', '/resellers/4/settlements')[0][1] as RequestInit).body)))
      .toEqual({ period_start: '2026-10-01', period_end: '2026-10-31' });
  });

  it('shows a refused period in words', async () => {
    override = (path, init) => {
      if (path === '/resellers/4/settlements' && init?.method === 'POST') {
        throw new ApiRequestError('overlap', 409, { error: { code: 'SETTLEMENT_PERIOD_OVERLAP', message: 'overlap' } });
      }
      return undefined;
    };
    const user = await openReseller();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another statement of this reseller already covers part of these dates.');
  });

  it('opens a draft with its totals and lines, and approves it', async () => {
    const user = await openReseller();
    await user.click(screen.getByRole('button', { name: 'View' }));
    const detail = await screen.findByRole('region', { name: 'Statement' });
    expect(within(detail).getByText('Commissions kept')).toBeInTheDocument();
    expect(within(detail).getAllByText('-$95.50', { selector: 'td' })).toHaveLength(2); // the total and its line
    expect(within(detail).getByRole('link', { name: 'F-0811' })).toHaveAttribute('href', '/invoices/811');
    await user.click(within(detail).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Statement approved. Its figures can no longer change.');
    expect(calls('POST', '/resellers/4/settlements/7/approve')).toHaveLength(1);
  });

  it('hides Approve without reseller_settlements.approve', async () => {
    mocks.user = { id: 1, role: 'manager', organization_currency: 'MXN', permissions: ['resellers.view', 'reseller_settlements.view', 'reseller_settlements.manage'] };
    const user = await openReseller();
    await user.click(screen.getByRole('button', { name: 'View' }));
    const detail = await screen.findByRole('region', { name: 'Statement' });
    expect(within(detail).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('settles an approved statement with its bank reference, or as already recorded', async () => {
    current = statement({ status: 'approved', approved_at: '2026-11-08T11:00:00Z' });
    const user = await openReseller();
    await user.click(screen.getByRole('button', { name: 'View' }));
    const detail = await screen.findByRole('region', { name: 'Statement' });
    expect(within(detail).getByText('This records that the reseller handed in $500.00 (a deposit in its movements).')).toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: 'Settle' }));
    expect(within(detail).getByRole('alert')).toHaveTextContent('Write the bank or transfer reference.');
    override = (path, init) => {
      if (path === '/resellers/4/settlements/7/settle' && init?.method === 'POST' && !JSON.parse(String(init.body)).record_only) {
        throw new ApiRequestError('moved', 409, { error: { code: 'SETTLEMENT_EXCEEDS_BALANCE', message: 'moved' } });
      }
      return undefined;
    };
    await user.type(within(detail).getByLabelText('Bank or transfer reference'), 'SPEI 123');
    await user.click(within(detail).getByRole('button', { name: 'Settle' }));
    expect(await within(detail).findByRole('alert')).toHaveTextContent('That money already moved since the period closed');
    await user.click(within(detail).getByLabelText('Already recorded; only mark it settled'));
    await user.click(within(detail).getByRole('button', { name: 'Settle' }));
    await screen.findByText('Statement settled.');
    const settles = calls('POST', '/resellers/4/settlements/7/settle');
    expect(JSON.parse(String((settles[settles.length - 1][1] as RequestInit).body))).toEqual({ bank_ref: 'SPEI 123', record_only: true });
  });

  it('downloads the PDF', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mocks.authedFetch.mockResolvedValue(new Response(new Blob(['%PDF']), {
      status: 200, headers: { 'Content-Disposition': 'attachment; filename="estado-de-cuenta-7.pdf"' },
    }));
    const user = await openReseller();
    await user.click(screen.getByRole('button', { name: 'View' }));
    const detail = await screen.findByRole('region', { name: 'Statement' });
    await user.click(within(detail).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(mocks.authedFetch).toHaveBeenCalledWith('/api/v1/resellers/4/settlements/7/pdf');
  });
});

describe('Mi caja: statements', () => {
  const RESELLER = {
    id: 7, role: 'billing', organization_currency: 'MXN',
    permissions: ['reseller_app.use', 'reseller_app.statements'],
    reseller_binding: { reseller_id: 4, reseller_name: 'Punto Norte' },
  };
  function puntoRespond(path: string): unknown {
    if (path === '/reseller-app/me') return { data: { reseller: { id: 4, name: 'Punto Norte' }, currency: 'MXN', counts: {}, money: {} } };
    if (path === '/reseller-app/cash-session') return { data: { current: null, recent: [] } };
    if (path.startsWith('/reseller-app/payments?')) return { data: [], meta: { total: 0, page: 1, limit: 20 } };
    if (path.startsWith('/reseller-app/ledger?')) return { data: [], summary: null, meta: { total: 0, page: 1, limit: 20 } };
    if (path.startsWith('/reseller-app/statements?')) {
      return {
        data: [
          statement({ id: 9, period_start: '2026-10-01', period_end: '2026-10-31', status: 'settled', bank_ref: 'SPEI 9', closing_balance: -80 }),
          statement({ id: 6, period_start: '2026-09-01', period_end: '2026-09-30', status: 'approved', closing_balance: 250 }),
        ],
        meta: { total: 2, page: 1, limit: 6 },
      };
    }
    throw new Error(`unexpected ${path}`);
  }

  it('lists the approved and settled statements with what was owed', async () => {
    mocks.user = RESELLER;
    mocks.apiFetch.mockImplementation(async (path: string) => puntoRespond(path));
    const user = userEvent.setup();
    wrap(<PuntoCash />);
    await user.click(await screen.findByRole('tab', { name: 'Statements' }));
    const section = screen.getByRole('tabpanel');
    await within(section).findByText('2026-10-01 to 2026-10-31');
    expect(within(section).getByText('We owed you $80.00')).toBeInTheDocument();
    expect(within(section).getByText('Settled · ref. SPEI 9')).toBeInTheDocument();
    expect(within(section).getByText('You had to hand in $250.00')).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: 'PDF' })).toHaveLength(2);
  });

  it('is hidden without reseller_app.statements', async () => {
    mocks.user = { ...RESELLER, permissions: ['reseller_app.use'] };
    mocks.apiFetch.mockImplementation(async (path: string) => puntoRespond(path));
    wrap(<PuntoCash />);
    await screen.findByRole('heading', { name: 'My cash' });
    expect(screen.queryByRole('tab', { name: 'Statements' })).toBeNull();
    expect(mocks.apiFetch.mock.calls.some(([p]) => String(p).startsWith('/reseller-app/statements'))).toBe(false);
  });
});
