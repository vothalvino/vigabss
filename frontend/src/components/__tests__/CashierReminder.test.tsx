import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CashierReminder } from '../CashierReminder';
import { SignOutWithCashierDialog } from '../SignOutWithCashierDialog';
import type { CashierAttention, MyCashier } from '../cashierReminderData';

let mine: MyCashier | null = null;
let attention: CashierAttention | null = null;
vi.mock('../cashierReminderData', () => ({
  useMyCashier: () => ({ data: mine }),
  useCashierAttention: () => ({ data: attention }),
}));

const open = (over: Partial<MyCashier> = {}): MyCashier => ({
  id: 7, opened_at: '2026-11-25T15:02:00Z', hours_open: 3, expected_total: 3450, max_open_hours: 16, overdue: false, ...over,
});
const show = (path = '/payments') => render(<MemoryRouter initialEntries={[path]}><CashierReminder /></MemoryRouter>);

describe('CashierReminder', () => {
  beforeEach(() => { mine = null; attention = null; });

  it('shows nothing to someone with no open cashier and nothing to review', () => {
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
  });

  it('tells the owner their cashier is open, the cash it expects, and links to close it', () => {
    mine = open();
    show();
    const bar = screen.getByTestId('my-cashier-bar');
    expect(bar).toHaveAttribute('role', 'status');
    expect(bar).toHaveTextContent('Your cashier has been open since');
    expect(bar).toHaveTextContent('Cash in the drawer: 3,450.00.');
    expect(screen.getByRole('link', { name: 'Close it' })).toHaveAttribute('href', '/cash-reconciliation');
  });

  it('turns into an alert once the cashier is past the allowed hours', () => {
    mine = open({ overdue: true, hours_open: 20 });
    show();
    const bar = screen.getByTestId('my-cashier-bar');
    expect(bar).toHaveAttribute('role', 'alert');
    expect(bar).toHaveTextContent('open for more than 16 hours');
  });

  it('says when the drawer is over the limit, and that a supervisor has to pick up cash', () => {
    mine = open({ expected_total: 6200, pickup_threshold: 5000, over_threshold: true });
    show();
    expect(screen.getByTestId('my-cashier-bar')).toHaveTextContent('That is over the 5,000.00 limit: ask a supervisor to pick up cash.');
  });

  it('says so more firmly when the limit is strict', () => {
    mine = open({ expected_total: 6200, pickup_threshold: 5000, over_threshold: true, pickup_strict: true });
    show();
    expect(screen.getByTestId('my-cashier-bar')).toHaveTextContent('a supervisor has to pick up cash before you can record more');
  });

  it('asks the owner to confirm a pickup a supervisor recorded', () => {
    mine = open({ pending_pickups: 1, pending_pickups_total: 4000 });
    show();
    expect(screen.getByTestId('my-cashier-bar')).toHaveTextContent('A supervisor recorded a pickup of 4,000.00 that waits for you to confirm.');
    expect(screen.getByRole('link', { name: 'Confirm it' })).toHaveAttribute('href', '/cash-reconciliation');
  });

  it('tells a supervisor who is over the cash limit and who opened with a different amount', () => {
    attention = {
      max_open_hours: 16, awaiting_review: 0, overdue_open: [],
      over_threshold: [{ id: 4, agent_user_id: 11, agent_name: 'Luis Peña', opened_at: 'x', hours_open: 2, cash_on_hand: 5500 }],
      opening_differences: [{ id: 5, agent_user_id: 12, agent_name: null, opened_at: 'x', hours_open: 1, opening_difference: -200 }],
    };
    show();
    const bar = screen.getByTestId('cashier-attention-bar');
    expect(bar).toHaveTextContent('1 cashier holds more than the cash limit: Luis Peña.');
    expect(bar).toHaveTextContent('1 cashier was opened with a different amount than it was closed with: #12.');
  });

  it('drops the link on the cashier page itself', () => {
    mine = open();
    show('/cash-reconciliation');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('tells a supervisor who left a cashier open and how many counts wait for a review', () => {
    attention = {
      max_open_hours: 16, awaiting_review: 2,
      overdue_open: [{ id: 3, agent_user_id: 10, agent_name: 'Ana Ruiz', opened_at: 'x', hours_open: 30 }],
    };
    show();
    const bar = screen.getByTestId('cashier-attention-bar');
    expect(bar).toHaveTextContent('1 cashier has been open for more than 16 hours: Ana Ruiz.');
    expect(bar).toHaveTextContent('2 counts did not match and wait for a review.');
    expect(screen.queryByTestId('my-cashier-bar')).not.toBeInTheDocument();
  });

  it('does not list a supervisor\'s own overdue cashier twice', () => {
    mine = open({ id: 3, overdue: true });
    attention = { max_open_hours: 16, awaiting_review: 0, overdue_open: [{ id: 3, agent_user_id: 1, agent_name: 'Me', opened_at: 'x', hours_open: 30 }] };
    show();
    expect(screen.getByTestId('my-cashier-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('cashier-attention-bar')).not.toBeInTheDocument();
  });
});

describe('SignOutWithCashierDialog', () => {
  it('offers to go to the cashier, sign out anyway or stay', () => {
    const go = vi.fn(); const out = vi.fn(); const cancel = vi.fn();
    render(<SignOutWithCashierDialog onGoToCashier={go} onSignOut={out} onCancel={cancel} />);
    expect(screen.getByRole('dialog', { name: 'Close your cashier first?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to my cashier' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Go to my cashier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect([go.mock.calls.length, out.mock.calls.length, cancel.mock.calls.length]).toEqual([1, 1, 1]);
  });
});
