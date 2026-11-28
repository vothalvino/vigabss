import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CashierPickupsRow, type CashPickup } from './CashierPickups';
import { CashierOpenDialog } from './CashierOpenDialog';
import { CashierRulesBox } from './CashierRulesBox';

const authedFetch = vi.fn();
vi.mock('@/api/client', () => ({ authedFetch: (...args: unknown[]) => authedFetch(...args) }));

const json = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 422, json: async () => (ok ? { data } : data) });
const wrap = (ui: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><table><tbody>{ui}</tbody></table></QueryClientProvider>);
};
const wrapPlain = (ui: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};
const posts = () => authedFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST').map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]);
const pickup = (over: Partial<CashPickup> = {}): CashPickup => ({
  id: 9, amount: 4000, status: 'pending', taken_by: 5, taken_by_name: 'Luis Peña', confirmed_by: null, note: 'a la caja fuerte', created_at: 'x', ...over,
});
const session = { id: 3, agent_user_id: 10, status: 'open', opening_total: '500.00', opening_expected: '500.00' };

describe('CashierPickupsRow', () => {
  beforeEach(() => authedFetch.mockReset());

  it('shows what the cashier was opened with, and that there are no pickups', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [] }));
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={5} canTake />);
    expect(await screen.findByText('None.')).toBeInTheDocument();
    expect(screen.getByText('Opened with:').parentElement).toHaveTextContent('Opened with: 500.00');
  });

  it('flags a cashier opened with a different amount than it was closed with', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [] }));
    wrap(<CashierPickupsRow session={{ ...session, opening_total: '300.00' }} colSpan={9} userId={5} canTake />);
    expect(await screen.findByText(/it had been closed with 500.00/)).toBeInTheDocument();
  });

  it('a supervisor records a pickup with the amount and a note', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [] }));
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={5} canTake />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record cash pickup' }));
    fireEvent.change(screen.getByLabelText('Amount taken'), { target: { value: '4000' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'a la caja fuerte' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash pickup' }));
    await waitFor(() => expect(posts()).toEqual([['/api/v1/cash-reconciliation/sessions/3/pickups', { amount: 4000, note: 'a la caja fuerte' }]]));
  });

  it('will not send a pickup without an amount, and shows the server\'s refusal', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [] }));
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={5} canTake />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record cash pickup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record cash pickup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the amount taken');
    expect(posts()).toEqual([]);
    authedFetch.mockResolvedValue(json({ error: { message: 'The cashier holds 900.00; a pickup cannot be more than that' } }, false));
    fireEvent.change(screen.getByLabelText('Amount taken'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record cash pickup' }));
    expect(await screen.findByText(/a pickup cannot be more than that/)).toBeInTheDocument();
  });

  it('someone who may not take cash from this cashier sees no record button', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [] }));
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={10} canTake={false} />);
    await screen.findByText('None.');
    expect(screen.queryByRole('button', { name: 'Record cash pickup' })).not.toBeInTheDocument();
  });

  it('the owner confirms or rejects a waiting pickup', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [pickup()] }));
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={10} canTake={false} />);
    expect(await screen.findByText('taken by Luis Peña')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the owner to confirm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts()[0][0]).toBe('/api/v1/cash-reconciliation/pickups/9/confirm'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts().map(([url]) => url)).toContain('/api/v1/cash-reconciliation/pickups/9/cancel'));
  });

  it('the supervisor who recorded it can cancel but not confirm; a third person can do neither', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [pickup()] }));
    const first = wrap(<CashierPickupsRow session={session} colSpan={9} userId={5} canTake />);
    await screen.findByText('taken by Luis Peña');
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    first.unmount();
    wrap(<CashierPickupsRow session={session} colSpan={9} userId={77} canTake={false} />);
    await screen.findByText('taken by Luis Peña');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a closed cashier lists its pickups but takes no new one', async () => {
    authedFetch.mockResolvedValue(json({ pickups: [pickup({ status: 'confirmed' })] }));
    wrap(<CashierPickupsRow session={{ ...session, status: 'approved' }} colSpan={9} userId={5} canTake />);
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record cash pickup' })).not.toBeInTheDocument();
  });
});

describe('CashierOpenDialog', () => {
  beforeEach(() => authedFetch.mockReset());

  it('asks for the cash counted and shows what the last close was', async () => {
    authedFetch.mockResolvedValue(json({ expected: 480 }));
    wrapPlain(<CashierOpenDialog onClose={vi.fn()} onOpened={vi.fn()} />);
    expect(await screen.findByText('You closed with 480.00 last time.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Cashier' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the cash you counted in the drawer.');
    expect(posts()).toEqual([]);
  });

  it('warns when the count differs from the last close, and still opens', async () => {
    authedFetch.mockResolvedValue(json({ expected: 480 }));
    const onOpened = vi.fn();
    wrapPlain(<CashierOpenDialog onClose={vi.fn()} onOpened={onOpened} />);
    await screen.findByText('You closed with 480.00 last time.');
    fireEvent.change(screen.getByLabelText('Cash counted in the drawer'), { target: { value: '300' } });
    expect(screen.getByRole('status')).toHaveTextContent('This is different from your last close.');
    fireEvent.click(screen.getByRole('button', { name: 'Open Cashier' }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(posts()).toEqual([['/api/v1/cash-reconciliation/sessions', { opening_total: 300 }]]);
  });

  it('a first cashier has no last close to show, and zero is a valid count', async () => {
    authedFetch.mockResolvedValue(json({ expected: null }));
    wrapPlain(<CashierOpenDialog onClose={vi.fn()} onOpened={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cash counted in the drawer'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Cashier' }));
    await waitFor(() => expect(posts()).toEqual([['/api/v1/cash-reconciliation/sessions', { opening_total: 0 }]]));
    expect(screen.queryByText(/You closed with/)).not.toBeInTheDocument();
  });
});

describe('CashierRulesBox', () => {
  beforeEach(() => authedFetch.mockReset());
  const rules = (over = {}) => json({ pickup_threshold: 0, pickup_strict: false, match_tolerance: 0, max_open_hours: 16, ...over });
  const puts = () => authedFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT').map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  it('with no limit nobody is reminded and strict cannot be turned on', async () => {
    authedFetch.mockResolvedValue(rules());
    wrapPlain(<CashierRulesBox canEdit />);
    expect(await screen.findByText('With a limit of 0 nobody is reminded to hand cash in.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('a supervisor sets the limit and makes it strict', async () => {
    authedFetch.mockResolvedValue(rules());
    wrapPlain(<CashierRulesBox canEdit />);
    await screen.findByLabelText('Cash limit for everyone else');
    fireEvent.change(screen.getByLabelText('Cash limit for everyone else'), { target: { value: '5000' } });
    expect(screen.getByText(/Cash can still be taken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/cannot record another cash payment until a supervisor picks up cash/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toEqual([{ pickup_threshold: 5000, pickup_strict: true }]));
    expect(await screen.findByText('Rules saved.')).toBeInTheDocument();
  });

  it('someone who is not a supervisor reads the rules and cannot change them', async () => {
    authedFetch.mockResolvedValue(rules({ pickup_threshold: 5000, pickup_strict: true }));
    wrapPlain(<CashierRulesBox canEdit={false} />);
    expect(await screen.findByLabelText('Cash limit for everyone else')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
