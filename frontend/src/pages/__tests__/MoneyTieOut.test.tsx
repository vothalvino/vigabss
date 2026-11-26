// Money tie-out page: the month's collections tied to the bank.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { MoneyTieOut } from '../tieout/MoneyTieOut';

const mockApiGet = vi.fn();
const mockFetch = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args) },
  authedFetch: (...args: unknown[]) => mockFetch(...args),
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

const transit = (over = {}) => ({ at_points: 0, owed_to_points: 0, in_bags: 0, in_drawers: 0, in_safe: 0, total: 0, position: 0, ...over });
const split = (over = {}) => ({ client_cfdi: 0, general_public_stamped: 0, general_public_pending: 0, unpaid_no_cfdi: 0, credit: 0, general_public: 0, ...over });
function makeReport(over: Record<string, unknown> = {}) {
  return {
    period: { year: 2026, month: 11, from: '2026-11-01', to: '2026-12-01', cutoff: '2026-11-26T18:00:00Z', closed: false, today: '2026-11-26' },
    collected: { count: 3, total: 1800, cash: 1300, cash_staff: 300, cash_points: 1000, non_cash: 500, by_method: [{ method: 'cash', total: 1300 }, { method: 'transfer', total: 500 }] },
    fiscal: { ...split({ client_cfdi: 500, general_public_pending: 900, credit: 400, general_public: 1300 }), cash: split({ client_cfdi: 200, general_public: 1100 }) },
    cash: {
      tracked: true, recorded: 1300, in_transit_start: transit(),
      in_transit_end: transit({ at_points: 360, in_drawers: 590, in_safe: 90, total: 1040, position: 1040 }),
      deposited: 700, commissions_kept: 50, other_out: 0, other_in: 0, reached_safe: { pickups: 200, bags: 590, handed_in: 0 },
      differences: { total: 490, cashier_counts: 490, bag_counts: -10, safe_counts: 0, point_adjustments: 10, point_payouts: 0, unexplained: 0 },
    },
    bank: {
      deposited: 700, cash_for_client_invoices: 200, cash_for_general_public: 1100,
      for_client_invoices: 500, for_general_public: 1300, in_client_invoice_accounts: 0, in_general_public_accounts: 1000,
      in_other_accounts: 0, direct_unassigned: 200,
      accounts: [{ id: 4, name: 'Public account', bank_name: 'Bank B', account_hint: '9876', purpose: 'general_public', status: 'active', deposits: 1, deposited: 700, payments: 2, received: 300 }],
    },
    attention: [{ kind: 'bag_waiting', bag_id: 3, serial: 'B-0003', point_name: 'Corner Store', status: 'ready_for_pickup', amount: 600, days: 5 }],
    resico: { applies: true, year: 2026, income: 1750000, limit: 3500000, percent: 50 },
    ...over,
  };
}

let report = makeReport();
function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><MoneyTieOut /></MemoryRouter></QueryClientProvider>);
}

describe('MoneyTieOut page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    report = makeReport();
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/money-tieout') return Promise.resolve({ data: { data: report }, error: undefined });
      if (path === '/money-tieout/safe-movements') {
        return Promise.resolve({ data: { data: [{ id: 9, kind: 'deposit', amount: 700, expected_amount: null, bank_account_id: 4, bank_account_name: 'Public account', moved_at: '2026-11-20T17:00:00Z', reference: 'slip 1', note: null, created_by: 1, created_by_name: 'Ana Admin' }] }, error: undefined });
      }
      return Promise.resolve({ data: { data: [] }, error: undefined });
    });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  });

  it('shows what was collected, how it is invoiced, where the cash is and that the month adds up', async () => {
    show();
    const collected = await screen.findByRole('region', { name: 'Collected' });
    expect(collected).toHaveTextContent('Cash taken by staff');
    expect(collected).toHaveTextContent('$300.00');
    expect(collected).toHaveTextContent('$1,800.00');
    const fiscal = screen.getByRole('region', { name: 'How it is invoiced' });
    expect(fiscal).toHaveTextContent('$500.00');
    expect(fiscal).toHaveTextContent('$1,300.00');
    expect(within(fiscal).getByRole('link', { name: 'Go to General Public invoices' })).toHaveAttribute('href', '/facturas-publicas');
    const transitCard = screen.getByRole('region', { name: 'Cash on its way to the bank' });
    expect(transitCard).toHaveTextContent('$1,040.00');
    const sum = screen.getByRole('region', { name: 'Does the month add up' });
    expect(sum).toHaveTextContent('Every peso is accounted for.');
    expect(sum).toHaveTextContent('Cashier counts');
    expect(screen.getByRole('region', { name: 'Needs attention' })).toHaveTextContent('Bag B-0003 of Corner Store');
    expect(screen.getByRole('region', { name: 'RESICO yearly limit' })).toHaveTextContent('50%');
    expect(await screen.findByText(/Public account · slip 1/)).toBeInTheDocument();
    const bank = screen.getByRole('region', { name: 'Bank accounts' });
    expect(bank).toHaveTextContent('Reached General Public accounts$1,000.00');
    expect(bank).toHaveTextContent('Paid by transfer, card or check with no account named$200.00');
    expect(bank).toHaveTextContent('$300.00 (2)');
  });

  it('says so when cash is left unexplained, and asks for a count before the safe is tracked', async () => {
    report = makeReport();
    (report.cash.differences as { unexplained: number }).unexplained = -25;
    const first = show();
    expect(await screen.findByText(/Some cash is not explained/)).toBeInTheDocument();
    first.unmount();

    report = makeReport();
    Object.assign(report.cash, { started_in_month: true, tracking_since: '2026-11-20T06:00:00Z' });
    (report.cash.differences as { unexplained: number }).unexplained = -25;
    const second = show();
    expect(await screen.findByText(/Cash from before that day was not followed/)).toBeInTheDocument();
    expect(screen.queryByText(/Some cash is not explained/)).not.toBeInTheDocument();
    second.unmount();

    report = makeReport({ cash: { ...makeReport().cash, tracked: false, differences: null, in_transit_end: transit({ in_safe: null }) } });
    show();
    expect(await screen.findByText(/Count the safe once to start/)).toBeInTheDocument();
    const safe = screen.getByRole('region', { name: 'Safe' });
    expect(within(safe).getByLabelText('Movement')).toBeDisabled();
    expect(within(safe).getByLabelText('Movement')).toHaveValue('count');
  });

  it('records a bank deposit with its account and slip, and adds a bank account', async () => {
    show();
    const safe = await screen.findByRole('region', { name: 'Safe' });
    fireEvent.change(within(safe).getByLabelText('Movement'), { target: { value: 'deposit' } });
    fireEvent.change(within(safe).getByLabelText('Amount'), { target: { value: '90' } });
    fireEvent.click(within(safe).getByRole('button', { name: 'Record' }));
    expect(await within(safe).findByRole('alert')).toHaveTextContent('Choose the bank account.');
    expect(mockFetch).not.toHaveBeenCalled();
    fireEvent.change(within(safe).getByLabelText('Bank account'), { target: { value: '4' } });
    fireEvent.change(within(safe).getByLabelText('Deposit slip'), { target: { value: 'slip 2' } });
    fireEvent.click(within(safe).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/money-tieout/safe-movements');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ kind: 'deposit', amount: 90, bank_account_id: 4, reference: 'slip 2' });

    const bank = screen.getByRole('region', { name: 'Bank accounts' });
    fireEvent.change(within(bank).getByLabelText('Account name'), { target: { value: 'Clients' } });
    fireEvent.change(within(bank).getByLabelText('Used for'), { target: { value: 'client_invoices' } });
    fireEvent.click(within(bank).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe('/api/v1/money-tieout/bank-accounts');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ name: 'Clients', purpose: 'client_invoices' });
  });

  it('shows the server reason when a movement is refused', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: { message: 'The safe holds 90.00; 500.00 cannot be taken out of it.' } }) });
    show();
    const safe = await screen.findByRole('region', { name: 'Safe' });
    fireEvent.change(within(safe).getByLabelText('Movement'), { target: { value: 'other_out' } });
    fireEvent.change(within(safe).getByLabelText('Amount'), { target: { value: '500' } });
    fireEvent.click(within(safe).getByRole('button', { name: 'Record' }));
    expect(await within(safe).findByRole('alert')).toHaveTextContent('The safe holds 90.00');
  });
});
