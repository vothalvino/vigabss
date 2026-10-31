// =============================================================================
// TNB-15 — staff page for subscriber self-service requests
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortalServiceRequestList } from '../PortalServiceRequestList';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@/api/client', () => ({
  api: { GET: (...a: unknown[]) => mockGet(...a), POST: (...a: unknown[]) => mockPost(...a) },
}));
let mockUser: { id: number; role: string; permissions?: string[] } = { id: 1, role: 'technician' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn(), language: 'en' } }),
}));

const ROWS = [
  { id: 7, client_id: 5, client_name: 'Ana', request_type: 'plan_upgrade', status: 'pending', payload: { current_plan_name: 'Basic', new_plan_name: 'Fiber 300', new_plan_id: '3' }, notes: null, created_at: '2026-10-30T10:00:00Z' },
  { id: 8, client_id: 6, client_name: 'Luis', request_type: 'pppoe_password_change', status: 'pending', payload: '{"has_new_password":true}', notes: null, created_at: '2026-10-30T11:00:00Z' },
  { id: 9, client_id: 7, client_name: 'Eva', request_type: 'static_ip_request', status: 'approved', payload: {}, notes: null, created_at: '2026-10-30T12:00:00Z' },
];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PortalServiceRequestList /></QueryClientProvider>);
}

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockUser = { id: 1, role: 'technician', permissions: ['portal_service_requests.view', 'portal_service_requests.update'] };
  mockGet.mockResolvedValue({ data: { data: ROWS, meta: { total: 3, page: 1, limit: 25, pages: 1 } } });
  mockPost.mockResolvedValue({ data: { data: {} } });
});

describe('PortalServiceRequestList', () => {
  it('lists pending requests by default with readable details and no password', async () => {
    renderPage();
    const row = (await screen.findByText('Ana')).closest('tr')!;
    expect(within(row).getByText(/Basic → Fiber 300/)).toBeInTheDocument();
    const pwRow = screen.getByText('Luis').closest('tr')!;
    expect(within(pwRow).getByText('portalServiceRequests.details.passwordProvided')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/portal-service-requests', expect.objectContaining({ params: { query: expect.objectContaining({ status: 'pending' }) } }));
  });

  it('approves a pending request with notes', async () => {
    renderPage();
    const row = (await screen.findByText('Ana')).closest('tr')!;
    fireEvent.click(within(row).getByText('portalServiceRequests.actions.approve'));
    fireEvent.change(screen.getByLabelText('portalServiceRequests.notes'), { target: { value: 'ok' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'portalServiceRequests.actions.approve' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/portal-service-requests/{id}/approve', { params: { path: { id: 7 } }, body: { notes: 'ok' } }));
  });

  it('offers "Mark completed" only for approved requests', async () => {
    renderPage();
    const approved = (await screen.findByText('Eva')).closest('tr')!;
    expect(within(approved).getByText('portalServiceRequests.actions.complete')).toBeInTheDocument();
    expect(within(approved).queryByText('portalServiceRequests.actions.approve')).toBeNull();
  });

  it('shows no actions without portal_service_requests.update', async () => {
    mockUser = { id: 2, role: 'readonly', permissions: ['portal_service_requests.view'] };
    renderPage();
    await screen.findByText('Ana');
    expect(screen.queryByText('portalServiceRequests.actions.approve')).toBeNull();
    expect(screen.queryByText('portalServiceRequests.actions.complete')).toBeNull();
  });
});
