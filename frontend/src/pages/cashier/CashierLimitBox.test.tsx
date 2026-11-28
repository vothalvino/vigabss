import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CashierLimitBox } from './CashierLimitBox';

const mockFetch = vi.fn();
vi.mock('@/api/client', () => ({ authedFetch: (...args: unknown[]) => mockFetch(...args) }));

const rules = { pickup_threshold: 1000, pickup_strict: false, default_pickup_threshold: 1000, default_pickup_strict: false };

describe('CashierLimitBox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  });

  it('says the person follows the company limit, and saves a limit of their own', async () => {
    const onSaved = vi.fn();
    render(<CashierLimitBox userId={7} name="Ana Ruiz" rules={rules} own={false} onSaved={onSaved} />);
    expect(screen.getByRole('region', { name: 'Cash limit of Ana Ruiz' })).toHaveTextContent("follows the company's limit ($1,000.00)");
    expect(screen.queryByRole('button', { name: "Use the company's limit" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cash the drawer may hold'), { target: { value: '2500' } });
    fireEvent.click(screen.getByLabelText('Stop cash payments at the limit until a pickup'));
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/v1/cash-reconciliation/staff/7/limit');
    expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ pickup_threshold: 2500, pickup_strict: true });
    expect(await screen.findByRole('status')).toHaveTextContent('Limit saved.');
    expect(onSaved).toHaveBeenCalled();
  });

  it('a limit of 0 cannot be strict, and a person with their own limit can go back to the company\'s', async () => {
    render(<CashierLimitBox userId={7} name="Ana Ruiz" rules={{ ...rules, pickup_threshold: 2500, pickup_strict: true }} own onSaved={vi.fn()} />);
    expect(screen.getByText('This limit was set for this person.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cash the drawer may hold'), { target: { value: '0' } });
    expect(screen.getByLabelText('Stop cash payments at the limit until a pickup')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ pickup_threshold: 0, pickup_strict: false });
    fireEvent.click(screen.getByRole('button', { name: "Use the company's limit" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][1].method).toBe('DELETE');
  });

  it('shows the reason when the server refuses, and does not send a bad amount', async () => {
    render(<CashierLimitBox userId={7} name="Ana Ruiz" rules={rules} own={false} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Cash the drawer may hold'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount of 0 or more.');
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: 'Your own cash limit is set by another supervisor.' } }) });
    fireEvent.change(screen.getByLabelText('Cash the drawer may hold'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('set by another supervisor');
  });
});
