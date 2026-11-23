// The portal home shows whether autopay is on with the one action that fits
// (set it up, or turn it off), and the Data packs tab is only offered to a
// subscriber whose plan has a data allowance. The Help and Account tabs are
// translated like the rest of the menu.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/auth/PortalAuthContext', () => ({
  portalAuthedFetch: (...a: unknown[]) => mocks.fetch(...a),
  usePortalAuth: () => ({ client: { name: 'Ana' }, logout: vi.fn() }),
}));

vi.mock('@/auth/DarkModeContext', () => ({ useDarkMode: () => ({ effectiveTheme: 'light', toggleTheme: vi.fn() }) }));

import { PortalAutopayCard } from '../PortalAutopayCard';
import { PortalLayout } from '@/components/PortalLayout';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const calls = () => mocks.fetch.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${String(url)}`);

function renderPage(page: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/portal']}>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('autopay on the portal home', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('off: says so and offers to set it up', async () => {
    mocks.fetch.mockResolvedValue(json({ data: { enabled: false, profile: null } }));
    renderPage(<PortalAutopayCard />);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable autopay' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off autopay' })).not.toBeInTheDocument();
  });

  it('on: names the card and turns it off only after a confirmation', async () => {
    let enabled = true;
    mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { enabled = false; return json({ message: 'Autopay disabled' }); }
      return json({ data: { enabled, profile: enabled ? { card_brand: 'visa', card_last_four: '4242' } : null } });
    });
    const user = userEvent.setup();
    renderPage(<PortalAutopayCard />);
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/card ending visa 4242/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable autopay' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Turn off autopay' }));
    expect(calls().filter((c) => c.startsWith('DELETE'))).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, turn it off' }));
    expect(await screen.findByText('Off')).toBeInTheDocument();
    expect(calls()).toContain('DELETE /api/v1/portal/autopay');
  });

  it('is on the home page and the Account page', () => {
    for (const page of ['PortalDashboard.tsx', 'PortalAccount.tsx']) {
      expect(readFileSync(resolve(__dirname, '..', page), 'utf8')).toMatch(/<PortalAutopayCard /);
    }
  });
});

describe('portal menu', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const withAllowance = (allowance: unknown) => {
    mocks.fetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/usage/allowance')) return json({ data: allowance });
      if (String(url).endsWith('/privacy-notice')) return json({ data: { accepted: true, version: '1', content: '', accepted_at: null } });
      return json({ data: { locale: 'MX', carta_derechos_url: 'https://example.com/carta' } });
    });
    renderPage(<PortalLayout />);
  };

  it('Data packs is offered when the plan has a data allowance', async () => {
    withAllowance({ base_cap_gb: 100, pack_gb: 0, rollover_gb: 0, total_gb: 100 });
    expect(await screen.findByRole('link', { name: /Data packs/i })).toBeInTheDocument();
  });

  it('Data packs is offered while the subscriber still holds a pack', async () => {
    withAllowance({ base_cap_gb: 0, pack_gb: 10, rollover_gb: 0, total_gb: 10 });
    expect(await screen.findByRole('link', { name: /Data packs/i })).toBeInTheDocument();
  });

  it('Data packs is not offered on an unlimited plan or without a contract', async () => {
    withAllowance({ base_cap_gb: 0, pack_gb: 0, rollover_gb: 0, total_gb: 0 });
    await waitFor(() => expect(calls()).toContain('GET /api/v1/portal/usage/allowance'));
    expect(screen.getByRole('link', { name: /Invoices/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Data packs/i })).not.toBeInTheDocument();
  });

  it('Help and Account are translated in every language', () => {
    for (const [locale, help, account] of [['en', 'Help', 'Account'], ['es', 'Ayuda', 'Cuenta'], ['pt-BR', 'Ajuda', 'Conta']]) {
      const layout = JSON.parse(readFileSync(resolve(__dirname, '../../../i18n/locales', `${locale}.json`), 'utf8')).portalLayout;
      expect(layout.navKb).toContain(help);
      expect(layout.navAccount).toContain(account);
    }
  });
});
