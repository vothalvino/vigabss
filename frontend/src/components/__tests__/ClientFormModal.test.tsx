import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', () => ({
  api: { GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() },
  tokenStore: { getAccess: () => 'tok', setAccess: vi.fn(), getRefresh: () => null, setRefresh: vi.fn(), clear: vi.fn() },
}));

let mockLocale: 'global' | 'MX' | undefined = 'global';
vi.mock('@/auth/AuthContext', () => ({
  useOptionalAuth: () => (mockLocale ? { user: { id: 1, organization_locale: mockLocale } } : undefined),
}));

import { ClientFormModal } from '../ClientFormModal';
import type { ClientFormModalProps } from '../ClientFormModal';

function renderModal(props: Partial<ClientFormModalProps> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ClientFormModal mode="create" onClose={vi.fn()} onSaved={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
  return screen.getByDisplayValue(/^(global|MX)$/) as HTMLSelectElement;
}

beforeEach(() => { mockLocale = 'global'; });

describe('ClientFormModal locale default', () => {
  it("a new client in an MX organization starts as MX", () => {
    mockLocale = 'MX';
    expect(renderModal().value).toBe('MX');
  });

  it('a new client in a global organization starts as global', () => {
    expect(renderModal().value).toBe('global');
  });

  it('without an auth context it falls back to global', () => {
    mockLocale = undefined;
    expect(renderModal().value).toBe('global');
  });

  it("editing keeps the client's own locale", () => {
    mockLocale = 'MX';
    expect(renderModal({ mode: 'edit', initial: { id: 5, name: 'Acme', locale: 'global' } }).value).toBe('global');
  });
});
