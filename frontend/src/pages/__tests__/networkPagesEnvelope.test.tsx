// =============================================================================
// FE2-01 — network pages render the shapes their routes really send
// =============================================================================
// Fixtures mirror the route handlers: wireless lists reply `{ data }` with no
// meta, link planning replies `{ data, total, page, limit }`, single objects
// come wrapped in `{ data }`, and DECIMAL columns arrive as strings. Each of
// these used to throw while rendering and blank the whole SPA.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { WirelessManagementPage } from '../WirelessManagementPage';
import { WirelessMetricsPage } from '../WirelessMetricsPage';
import { PonPortManagementPage } from '../PonPortManagementPage';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { listTotal, unwrapData, fmtFixed } from '@/api/envelope';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...a: unknown[]) => mockGet(...a), POST: (...a: unknown[]) => mockPost(...a), PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}));

function renderPage(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}
const body = (data: unknown) => Promise.resolve({ data, error: undefined });

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation(() => body({ data: [] }));
});

describe('envelope helpers', () => {
  it('listTotal reads meta.total, a top-level total, or counts the rows', () => {
    expect(listTotal({ data: [1, 2], meta: { total: 40 } })).toBe(40);
    expect(listTotal({ data: [1], total: 7, page: 1, limit: 20 })).toBe(7);
    expect(listTotal({ data: [1, 2, 3] })).toBe(3);
    expect(listTotal(undefined)).toBe(0);
  });
  it('unwrapData unwraps { data } and passes bare payloads through', () => {
    expect(unwrapData({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapData({ a: 1 })).toEqual({ a: 1 });
  });
  it('fmtFixed accepts DECIMAL strings and missing values', () => {
    expect(fmtFixed('-21.5000', 2)).toBe('-21.50');
    expect(fmtFixed(null, 1)).toBe('—');
    expect(fmtFixed('n/a', 1)).toBe('—');
  });
});

describe('pages', () => {
  it('/wireless renders its default AP-sectors tab from a { data } list without meta', async () => {
    renderPage(<WirelessManagementPage />);
    // The loaded (empty) list renders; before, computing meta.total threw.
    expect(await screen.findByText('wirelessManagement.apSectors.noItems')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/wireless/ap-sectors', expect.anything());
  });

  it('/wireless-metrics link planning lists saved calcs with DECIMAL strings', async () => {
    mockGet.mockImplementation((path: string) => (path === '/wireless/link-planning'
      ? body({ data: [{ id: 1, name: 'Tower A-B', frequency_mhz: 5800, distance_km: '12.3450', link_budget_db: '-58.2000', created_at: '2026-10-01T00:00:00Z' }], total: 1, page: 1, limit: 20 })
      : body({ data: [] })));
    renderPage(<WirelessMetricsPage />);
    fireEvent.click(await screen.findByText('wirelessMetrics.tabs.linkPlanning'));
    const row = (await screen.findByText('Tower A-B')).closest('tr')!;
    expect(within(row).getByText('12.345')).toBeInTheDocument();
    expect(within(row).getByText('-58.2')).toBeInTheDocument();
  });

  it('/pon-port-management shows a wrapped utilization payload with string optical values', async () => {
    mockGet.mockImplementation((path: string) => (path === '/olt-management/ports/{portId}/utilization'
      ? body({ data: {
        port: { id: 4, port_name: 'PON 0/1/4', olt_name: 'OLT-Centro', onu_count: 12, max_onus: 64, tx_power_dbm: null, rx_power_dbm: null, bandwidth_up_bps: null, bandwidth_down_bps: null, maintenance_mode: 0, maintenance_note: null, xgspon_mode: 'gpon', xgspon_mode_validated: 1 },
        onu_state_counts: [{ onu_state: 'online', cnt: 12 }],
        optical_summary: { avg_rx_dbm: '-21.5000', min_rx_dbm: '-24.1000', max_rx_dbm: '-19.0000', avg_tx_dbm: '2.1000' },
      } })
      : body({ data: [] })));
    renderPage(<PonPortManagementPage />);
    fireEvent.change(screen.getByPlaceholderText('ponPortManagement.utilization.portId'), { target: { value: '4' } });
    expect(await screen.findByText(/PON 0\/1\/4/)).toBeInTheDocument();
    expect(screen.getByText('-21.50')).toBeInTheDocument();
    expect(screen.getByText('-24.10')).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('shows a message instead of unmounting everything', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): ReactNode { throw new TypeError("Cannot read properties of undefined (reading 'total')"); }
    render(<div><p>sidebar</p><ErrorBoundary><Broken /></ErrorBoundary></div>);
    expect(screen.getByRole('alert')).toHaveTextContent('errorBoundary.title');
    expect(screen.getByText('sidebar')).toBeInTheDocument();
    spy.mockRestore();
  });
});
