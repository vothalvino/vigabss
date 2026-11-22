// BIL-35 — sandbox CFDIs are badged, and a test install (the install's
// live/test switch) shows a persistent banner on billing pages.
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
vi.mock('@/api/client', () => ({ api: { GET: (...args: unknown[]) => getMock(...args) } }));
let installMode: 'live' | 'test' | undefined;
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: { organization_id: 1, permissions: ['cfdi_documents.view'], install_mode: installMode } }),
}));
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
  it('shows on a test install, without asking the server', () => {
    installMode = 'test';
    wrap(<SandboxEnvironmentBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(/DEV MODE/);
    expect(getMock).not.toHaveBeenCalled();
  });

  it.each([['live' as const], [undefined]])('stays hidden when the install mode is %s', (mode) => {
    installMode = mode;
    wrap(<SandboxEnvironmentBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
