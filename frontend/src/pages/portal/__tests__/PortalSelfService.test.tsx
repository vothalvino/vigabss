// FE-26: the portal had no page for changing the password, the payment
// history, or data packs and the allowance, though the API had all of them;
// and the chat page was routed but not linked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/auth/PortalAuthContext', () => ({ portalAuthedFetch: (...a: unknown[]) => mocks.fetch(...a) }));

import { PortalSecurity } from '../PortalSecurity';
import { PortalPayments } from '../PortalPayments';
import { PortalDataPacks } from '../PortalDataPacks';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function renderPage(page: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const calls = () => mocks.fetch.mock.calls.map(([url, init]) => ({ url: String(url), method: (init as RequestInit | undefined)?.method ?? 'GET', body: (init as RequestInit | undefined)?.body }));

describe('portal self-service pages', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('Security changes the password with the current one, after checking the confirmation', async () => {
    mocks.fetch.mockResolvedValue(json({ message: 'Password updated successfully' }));
    const user = userEvent.setup();
    renderPage(<PortalSecurity />);

    await user.type(screen.getByLabelText('Current password'), 'old-secret');
    await user.type(screen.getByLabelText('New password'), 'new-secret-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-secret-2');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(mocks.fetch).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('has been changed');
    expect(calls()).toEqual([{
      url: '/api/v1/portal/auth/password', method: 'PUT',
      body: JSON.stringify({ currentPassword: 'old-secret', newPassword: 'new-secret-1' }),
    }]);
  });

  it('Security shows the server\'s refusal', async () => {
    mocks.fetch.mockResolvedValue(json({ error: { message: 'Current password is incorrect' } }, 422));
    const user = userEvent.setup();
    renderPage(<PortalSecurity />);
    await user.type(screen.getByLabelText('Current password'), 'wrong');
    await user.type(screen.getByLabelText('New password'), 'new-secret-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-secret-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
  });

  it('Payments lists the payment history', async () => {
    mocks.fetch.mockResolvedValue(json({
      data: [{ id: 1, amount: '500', currency: 'MXN', payment_method: 'spei', payment_date: '2026-10-05T00:00:00Z', reference_number: 'REF-1', status: 'completed' }],
      meta: { page: 1, limit: 20, total: 1, pages: 1 },
    }));
    renderPage(<PortalPayments />);
    expect(await screen.findByText('500.00 MXN')).toBeInTheDocument();
    expect(screen.getByText('SPEI')).toBeInTheDocument();
    expect(screen.getByText('REF-1')).toBeInTheDocument();
    expect(calls()[0].url).toBe('/api/v1/portal/payments?page=1&limit=20');
  });

  it('Data packs shows the allowance and buys a pack only after confirmation', async () => {
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/usage/allowance')) return json({ data: { base_cap_gb: 100, pack_gb: 10, rollover_gb: 0, total_gb: 110 } });
      if (url.endsWith('/data-packs')) return json({ data: [{ id: 3, name: 'Extra 10', description: null, data_gb: '10.000', price: '99.00', currency: 'MXN', validity_days: 30 }] });
      if (url.endsWith('/my-purchases')) return json({ data: [] });
      if (init?.method === 'POST') return json({ data: { id: 1 } }, 201);
      return json({});
    });
    const user = userEvent.setup();
    renderPage(<PortalDataPacks />);

    expect(await screen.findByText('110 GB')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Buy' }));
    expect(screen.getByText('An invoice for 99.00 MXN will be issued.')).toBeInTheDocument();
    expect(calls().filter(c => c.method === 'POST')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Confirm purchase' }));
    await waitFor(() => expect(calls().filter(c => c.method === 'POST').map(c => c.url)).toEqual(['/api/v1/portal/data-packs/3/purchase']));
    expect(await screen.findByRole('status')).toHaveTextContent('Extra 10 was added');
  });

  it('the portal navigation links the new pages and the chat', () => {
    const layout = readFileSync(resolve(__dirname, '../../../components/PortalLayout.tsx'), 'utf8');
    for (const path of ['/portal/payments', '/portal/data-packs', '/portal/security', '/portal/chat']) {
      expect(layout).toContain(`to="${path}"`);
    }
  });
});
