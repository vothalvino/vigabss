// BIL-35 — sandbox CFDIs are badged, and a production install still on the
// sandbox PAC shows a persistent banner.
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('@/api/client', () => ({ api: { GET: (...args: unknown[]) => getMock(...args) } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { organization_id: 1, permissions: ['cfdi_documents.view'] } }) }));
vi.mock('@/auth/permissions', () => ({ can: () => true }));

import { isSandboxCfdi, SandboxCfdiBadge, SandboxEnvironmentBanner } from '../SandboxFiscal';

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => getMock.mockReset());

describe('isSandboxCfdi', () => {
  it('reads the recorded environment and legacy SIMULADO UUIDs', () => {
    expect(isSandboxCfdi({ pac_environment: 'sandbox' })).toBe(true);
    expect(isSandboxCfdi({ pac_environment: null, uuid: 'SIMULADO-1234' })).toBe(true);
    expect(isSandboxCfdi({ pac_environment: 'production', uuid: 'a1b2' })).toBe(false);
    expect(isSandboxCfdi(null)).toBe(false);
  });
});

describe('SandboxCfdiBadge', () => {
  it('renders only for a sandbox CFDI', () => {
    const { rerender, container } = wrap(<SandboxCfdiBadge doc={{ pac_environment: 'sandbox' }} />);
    expect(container.textContent).not.toBe('');
    rerender(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SandboxCfdiBadge doc={{ pac_environment: 'production' }} /></MemoryRouter></QueryClientProvider>);
    expect(container.textContent).toBe('');
  });
});

describe('SandboxEnvironmentBanner', () => {
  it('warns on a production install whose organization uses the sandbox PAC', async () => {
    getMock.mockResolvedValue({ data: { data: { pac_environment: 'sandbox', production_install: true } } });
    wrap(<SandboxEnvironmentBanner />);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });

  it.each([
    [{ pac_environment: 'production', production_install: true }],
    [{ pac_environment: 'sandbox', production_install: false }],
  ])('stays hidden for %o', async (env) => {
    getMock.mockResolvedValue({ data: { data: env } });
    wrap(<SandboxEnvironmentBanner />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
