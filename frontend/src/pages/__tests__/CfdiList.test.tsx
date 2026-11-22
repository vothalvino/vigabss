// The CFDI list: column headers sort the whole list on the server (newest
// first by default), the filters and the sort reach the request together, and
// the page takes its colours from the theme so it stays readable in dark mode.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fetchMock = vi.fn();
vi.mock('@/api/client', () => ({
  authedFetch: (...args: unknown[]) => fetchMock(...args),
  tokenStore: { getAccess: () => 'tok' },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, permissions: [], install_mode: 'live' } }) }));
vi.mock('@/auth/permissions', () => ({ can: () => true }));

import { CfdiList } from '../CfdiList';

const DOC = {
  id: 7, uuid: 'ABCDEF12-0000-4000-8000-000000000000', tipo_comprobante: 'I', receptor_rfc: 'XAXX010101000',
  receptor_nombre: 'PUBLICO EN GENERAL', total: '232.00', moneda: 'MXN', sat_status: 'vigente', pac_provider: 'finkok',
  pac_environment: 'production', stamp_date: '2026-11-01T10:00:00Z', created_at: '2026-11-01T10:00:00Z',
};
let meta = { total: 51, page: 1, limit: 25, totalPages: 3 };
let rows: unknown[] = [DOC];

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><CfdiList /></MemoryRouter></QueryClientProvider>);
}
const lastQuery = () => new URLSearchParams(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).split('?')[1]);

beforeEach(() => {
  vi.clearAllMocks();
  meta = { total: 51, page: 1, limit: 25, totalPages: 3 };
  rows = [DOC];
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: rows, meta }) }));
});

describe('CfdiList', () => {
  it('lists newest first by default', async () => {
    renderList();
    await screen.findByText('XAXX010101000');
    expect(Object.fromEntries(lastQuery())).toMatchObject({ page: '1', limit: '25', order_by: 'id', order: 'DESC' });
  });

  it('a column header sorts the whole list on the server; a second click reverses it', async () => {
    renderList();
    await screen.findByText('XAXX010101000');

    fireEvent.click(screen.getByRole('columnheader', { name: /Total/ }));
    await waitFor(() => expect(lastQuery().get('order_by')).toBe('total'));
    expect(lastQuery().get('order')).toBe('ASC');
    expect(screen.getByRole('columnheader', { name: /Total/ })).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(screen.getByRole('columnheader', { name: /Total/ }));
    await waitFor(() => expect(lastQuery().get('order')).toBe('DESC'));

    fireEvent.click(screen.getByRole('columnheader', { name: /Status/ }));
    await waitFor(() => expect(lastQuery().get('order_by')).toBe('sat_status'));
  });

  it('every data column sorts; Actions does not', async () => {
    renderList();
    await screen.findByText('XAXX010101000');
    const sortable = screen.getAllByRole('columnheader').filter(h => h.hasAttribute('aria-sort')).map(h => h.textContent?.replace(/[▲▼↕]/g, '').trim());
    expect(sortable).toEqual(['UUID / ID', 'Type', 'Receptor', 'Total', 'Date', 'Status', 'PAC']);
    expect(screen.getByRole('columnheader', { name: 'Actions' })).not.toHaveAttribute('aria-sort');
  });

  it('filters and sort travel together, and sorting returns to the first page', async () => {
    renderList();
    await screen.findByText('XAXX010101000');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(lastQuery().get('page')).toBe('2'));

    fireEvent.click(screen.getByRole('button', { name: 'Vigente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pago' }));
    await waitFor(() => expect(lastQuery().get('tipo_comprobante')).toBe('P'));
    expect(lastQuery().get('sat_status')).toBe('vigente');
    expect(lastQuery().get('page')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(lastQuery().get('page')).toBe('2'));
    fireEvent.click(screen.getByRole('columnheader', { name: /Date/ }));
    await waitFor(() => expect(lastQuery().get('order_by')).toBe('created_at'));
    expect(Object.fromEntries(lastQuery())).toMatchObject({ page: '1', sat_status: 'vigente', tipo_comprobante: 'P' });
  });

  it('an empty result reads "1 / 1", not "1 / 0"', async () => {
    rows = [];
    meta = { total: 0, page: 1, limit: 25, totalPages: 0 };
    renderList();
    await screen.findByText(/No CFDI documents found/i);
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();
  });

  it('takes its neutral colours from the theme (readable in dark mode)', () => {
    const src = readFileSync(resolve(__dirname, '../CfdiList.tsx'), 'utf8');
    // Greys and whites that only suit the light theme. Coloured status pills
    // and white text on coloured buttons are deliberate and stay.
    for (const fixed of ['#374151', '#6b7280', '#9ca3af', '#d1d5db', '#e5e7eb', '#f9fafb', '#f3f4f6', '#fafafa']) {
      expect(src, fixed).not.toContain(fixed);
    }
    expect(src).not.toMatch(/background: '#fff'/);
    const pager = src.slice(src.indexOf('const pageBtn'));
    expect(pager).toMatch(/background: 'var\(--bg-card\)', color: 'var\(--text-primary\)'/);
    // The shared sortable header no longer forces a dark grey either.
    expect(readFileSync(resolve(__dirname, '../../components/SortableTh.tsx'), 'utf8')).not.toContain('#374151');
  });
});
