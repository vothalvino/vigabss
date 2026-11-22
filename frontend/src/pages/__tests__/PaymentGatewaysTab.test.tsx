// Whether the install takes test or live keys is the install's live/test switch.
// The gateways tab shows it, reads a Stripe gateway's side from the row the
// server derived, and can ask the provider whether the stored key works.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockApiFetch = vi.fn();
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
let mode: 'test' | 'live';
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, install_mode: mode } }) }));

import { PaymentGatewaysTab } from '../settings/PaymentGatewaysTab';

const STRIPE = {
  id: 5, provider: 'stripe', name: 'Stripe MX', environment: 'sandbox', public_key: null,
  has_secret_key: true, has_webhook_secret: true, status: 'active', organization_id: 1, created_at: '2026-01-01',
};
let testAnswer: { ok: boolean; mode?: string; error?: string };

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PaymentGatewaysTab /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mode = 'test';
  testAnswer = { ok: true, mode: 'test' };
  mockApiFetch.mockImplementation((path: string) => {
    if (path.endsWith('/payment-gateways/5/test')) return Promise.resolve({ data: testAnswer });
    if (path.includes('/payment-gateways?')) return Promise.resolve({ data: [STRIPE], meta: { total: 1 } });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
});

describe('PaymentGatewaysTab', () => {
  it('shows the test-mode banner and the gateway as Test on a test install', async () => {
    renderTab();
    expect(await screen.findByText(/DEV MODE/)).toBeInTheDocument();
    expect(await screen.findByText('Test')).toBeInTheDocument();
  });

  it('shows no banner on a live install', async () => {
    mode = 'live';
    renderTab();
    await screen.findByText('Stripe MX');
    expect(screen.queryByText(/DEV MODE/)).not.toBeInTheDocument();
  });

  it('tests the stored key and reports the result', async () => {
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection works (Test key).')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/payment-gateways/5/test', { method: 'POST' });
  });

  it('reports a refused key', async () => {
    testAnswer = { ok: false, error: 'The payment provider refused the request (HTTP 401)' };
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Connection failed: The payment provider refused/)).toBeInTheDocument();
  });

  it('a Stripe gateway has no environment to choose, and lists the dispute-closed event', async () => {
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Read from the secret key.')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'production' })).not.toBeInTheDocument();
    expect(screen.getByText(/charge\.dispute\.closed/)).toBeInTheDocument();
  });
});
