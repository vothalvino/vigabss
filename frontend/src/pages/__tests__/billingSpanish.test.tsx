// The staff billing pages (credit notes, invoice detail, payment actions)
// rendered English whatever the user's language: their text was written into
// the JSX. It is in the locale files now, so a Spanish session sees Spanish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { CreditNoteList, CreditNoteModal } from '../CreditNoteList';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import pt from '@/i18n/locales/pt-BR.json';

const mockApiGet = vi.fn();
vi.mock('@/auth/useOrgCurrency', () => ({ useOrgCurrency: () => 'MXN' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, email: 'a@b.c', organization_locale: 'MX' } }) }));
vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args), POST: vi.fn() },
  authedFetch: vi.fn(),
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('billing pages in Spanish', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('es');
    mockApiGet.mockResolvedValue({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } }, error: undefined });
  });
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('the credit note list', async () => {
    wrap(<CreditNoteList />);
    expect(await screen.findByText('🧾 Notas de crédito')).toBeTruthy();
    expect(screen.getByText('+ Nueva nota de crédito')).toBeTruthy();
    expect(screen.getByText('Cargando…')).toBeTruthy();
    expect(screen.queryByText('Credit Notes', { exact: false })).toBeNull();
  });

  it('the credit note form', () => {
    wrap(<CreditNoteModal creditNote={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Número de nota de crédito')).toBeTruthy();
    expect(screen.getByText('Cancelar')).toBeTruthy();
    expect(screen.queryByText('Credit Note Number')).toBeNull();
  });

  it('every billing page string has a Spanish and a Portuguese translation', () => {
    const at = (cat: Record<string, unknown>, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], cat) as Record<string, string>;
    for (const ns of ['invoiceDetail.ui', 'paymentActions', 'creditNoteList']) {
      const keys = Object.keys(at(en, ns)).sort();
      expect(Object.keys(at(es, ns)).sort()).toEqual(keys);
      expect(Object.keys(at(pt, ns)).sort()).toEqual(keys);
    }
  });
});
