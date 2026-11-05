// About 2,400 staff-page strings (headings, form labels, empty states,
// buttons) were written into the JSX, so a user who chose Spanish or
// Portuguese still read English on most pages. They are in the locale files
// under `ui.<page>` now; these pages render in the language chosen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { VlanList } from '../VlanList';
import { PlanList } from '../PlanList';

vi.mock('@/api/client', () => ({
  api: { GET: vi.fn(async () => ({ data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } }, error: undefined })) },
  authedFetch: vi.fn(),
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
vi.mock('@/auth/useOrgCurrency', () => ({ useOrgCurrency: () => 'MXN' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', permissions: ['*'] } }) }));

function renderPage(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('staff pages follow the chosen language', () => {
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('Spanish', async () => {
    await i18n.changeLanguage('es');
    renderPage(<VlanList />);
    expect(await screen.findByText('🔌 VLAN')).toBeTruthy();
    expect(await screen.findByText(/No se encontraron VLAN/)).toBeTruthy();
    expect(screen.queryByText(/No VLANs found/)).toBeNull();
  });

  it('Portuguese', async () => {
    await i18n.changeLanguage('pt-BR');
    renderPage(<PlanList />);
    expect(await screen.findByText('📶 Planos')).toBeTruthy();
    expect(screen.queryByText('📶 Plans')).toBeNull();
  });
});
