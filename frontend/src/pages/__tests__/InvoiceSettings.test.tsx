// Invoice Settings: the prefix of invoice numbers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { InvoiceSettings } from '../InvoiceSettings';

const mockFetch = vi.fn();
vi.mock('@/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockFetch(...args),
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));

let stored: Record<string, unknown>;
function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><InvoiceSettings /></MemoryRouter></QueryClientProvider>);
}
const puts = () => mockFetch.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT');

describe('InvoiceSettings: number prefix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = { logo_url: null, header_color: '#1a5276', footer_legal: null, payment_instructions: null, number_prefix: null, default_number_prefix: 'REM', effective_number_prefix: 'REM' };
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') stored = { ...stored, ...JSON.parse(String(init.body)) };
      return Promise.resolve({ ok: true, json: async () => stored });
    });
  });

  it('shows the default as the example until a prefix is typed, then the typed one in upper case', async () => {
    show();
    const field = await screen.findByLabelText('Invoice number prefix');
    await waitFor(() => expect(field).toHaveAttribute('placeholder', 'REM'));
    expect(screen.getByText(/numbered like REM-000123\. Leave it empty to use REM\./)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'nota-' } });
    expect(field).toHaveValue('NOTA-');
    expect(screen.getByText(/numbered like NOTA-000123/)).toBeInTheDocument();
  });

  it('saves the prefix with the other settings, and an empty one to go back to the default', async () => {
    show();
    const field = await screen.findByLabelText('Invoice number prefix');
    await waitFor(() => expect(field).toHaveAttribute('placeholder', 'REM'));
    fireEvent.change(field, { target: { value: 'FAC' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toMatchObject({ number_prefix: 'FAC', header_color: '#1a5276' });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(JSON.parse(String((puts()[1][1] as RequestInit).body)).number_prefix).toBe('');
  });

  it('shows the reason when the server refuses a prefix', async () => {
    show();
    const field = await screen.findByLabelText('Invoice number prefix');
    await waitFor(() => expect(field).toHaveAttribute('placeholder', 'REM'));
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => (init?.method === 'PUT'
      ? Promise.resolve({ ok: false, status: 422, json: async () => ({ error: { message: 'number_prefix: use 1 to 10 letters, digits or dashes, starting with a letter or a digit' } }) })
      : Promise.resolve({ ok: true, json: async () => stored })));
    fireEvent.change(field, { target: { value: 'A B' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/use 1 to 10 letters, digits or dashes/)).toBeInTheDocument();
  });
});
