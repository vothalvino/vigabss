import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ListFilters, EMPTY_LIST_FILTERS, listFilterKey, listFilterQuery, type ListFilterValue } from '../ListFilters';

vi.mock('@/api/client', () => ({ api: { GET: vi.fn().mockResolvedValue({ data: { data: [] }, error: undefined }) } }));

describe('ListFilters', () => {
  it('turns a value into query parameters, leaving unset filters out', () => {
    expect(listFilterQuery(EMPTY_LIST_FILTERS)).toEqual({});
    const value: ListFilterValue = { from: '2026-11-01', to: '2026-11-30', clientId: 7, clientName: 'Acme' };
    expect(listFilterQuery(value)).toEqual({ date_from: '2026-11-01', date_to: '2026-11-30', client_id: 7 });
    expect(listFilterKey(value)).not.toBe(listFilterKey({ ...value, to: '2026-11-29' }));
  });

  it('reports each date as it changes and keeps the range in order', () => {
    const onChange = vi.fn();
    render(<ListFilters value={{ ...EMPTY_LIST_FILTERS, from: '2026-11-10' }} onChange={onChange} dateLabel="Issue date" />);
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
    const to = screen.getByLabelText('To');
    expect(to).toHaveAttribute('min', '2026-11-10');
    fireEvent.change(to, { target: { value: '2026-11-20' } });
    expect(onChange).toHaveBeenCalledWith({ from: '2026-11-10', to: '2026-11-20', clientId: null, clientName: '' });
    fireEvent.change(screen.getByLabelText('Issue date from'), { target: { value: '2026-11-05' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ from: '2026-11-05' }));
  });

  it('offers to clear only when something is set, and shows the chosen client', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ListFilters value={EMPTY_LIST_FILTERS} onChange={onChange} dateLabel="Payment date" />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    rerender(<ListFilters value={{ from: '', to: '', clientId: 7, clientName: 'Acme Corp' }} onChange={onChange} dateLabel="Payment date" />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onChange).toHaveBeenCalledWith(EMPTY_LIST_FILTERS);
  });

  it('leaves the client out on a list that has none', () => {
    render(<ListFilters value={EMPTY_LIST_FILTERS} onChange={vi.fn()} dateLabel="Opened" showClient={false} />);
    expect(screen.queryByLabelText('Client')).not.toBeInTheDocument();
  });
});
