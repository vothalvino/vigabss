import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CashierReviewDialog } from './CashierReviewDialog';

const authedFetch = vi.fn();
vi.mock('@/api/client', () => ({ authedFetch: (...args: unknown[]) => authedFetch(...args) }));

function show(decision: 'approve' | 'dispute') {
  const onDone = vi.fn(); const onClose = vi.fn();
  render(<CashierReviewDialog sessionId={4} decision={decision} variance="-20.00" onClose={onClose} onDone={onDone} />);
  return { onDone, onClose };
}

describe('CashierReviewDialog', () => {
  beforeEach(() => authedFetch.mockReset());

  it('will not send a review without a note', async () => {
    show('approve');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a note explaining the difference.');
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('approves with the note', async () => {
    authedFetch.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    const { onDone } = show('approve');
    expect(screen.getByText(/differs from the cash expected by -20.00/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' gave wrong change, repaid ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = authedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/cash-reconciliation/sessions/4/approve');
    expect(JSON.parse(String(init.body))).toEqual({ note: 'gave wrong change, repaid' });
  });

  it('disputes through the dispute address and shows the server\'s refusal', async () => {
    authedFetch.mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'You cannot review your own cashier; another supervisor has to.' } }) });
    const { onDone } = show('dispute');
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: '20 missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dispute' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot review your own cashier');
    expect((authedFetch.mock.calls[0] as [string])[0]).toBe('/api/v1/cash-reconciliation/sessions/4/dispute');
    expect(onDone).not.toHaveBeenCalled();
  });
});
