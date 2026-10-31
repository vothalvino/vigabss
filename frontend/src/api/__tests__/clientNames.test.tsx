// =============================================================================
// FE-04 — list pages name every client on the page, not just the newest 100
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useClientNames } from '../clientNames';

const mockGet = vi.fn();
vi.mock('@/api/client', () => ({ api: { GET: (...a: unknown[]) => mockGet(...a) } }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => mockGet.mockReset());

describe('useClientNames', () => {
  it('asks for exactly the ids on the page, archived clients included', async () => {
    // Client 250 is far outside the newest 100 the old map was built from.
    mockGet.mockResolvedValue({ data: { data: [{ id: 3, name: 'Old client' }, { id: 250, name: 'Ana López' }] } });
    const { result } = renderHook(() => useClientNames([250, 3, 3, null, undefined]), { wrapper });
    await waitFor(() => expect(result.current.get(250)).toBe('Ana López'));
    expect(result.current.get(3)).toBe('Old client');
    expect(mockGet).toHaveBeenCalledWith('/clients', { params: { query: { ids: '3,250', include_deleted: 'true', limit: 100 } } });
  });

  it('makes no request for an empty page', () => {
    const { result } = renderHook(() => useClientNames([]), { wrapper });
    expect(result.current.size).toBe(0);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
