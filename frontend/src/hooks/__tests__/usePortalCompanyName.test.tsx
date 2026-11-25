import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePortalCompanyName, resetPortalCompanyNameCache } from '../usePortalCompanyName';

function answer(body: unknown, ok = true) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok, json: async () => body } as Response);
}

describe('usePortalCompanyName', () => {
  beforeEach(() => resetPortalCompanyNameCache());
  afterEach(() => vi.restoreAllMocks());

  it('gives the company name the server reports and asks only once', async () => {
    const spy = answer({ data: { organization_name: 'Red Norte' } });
    const first = renderHook(() => usePortalCompanyName());
    await waitFor(() => expect(first.result.current).toBe('Red Norte'));
    const second = renderHook(() => usePortalCompanyName());
    expect(second.result.current).toBe('Red Norte');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives nothing when the server names no company or fails', async () => {
    answer({ data: { organization_name: null } });
    const a = renderHook(() => usePortalCompanyName());
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(a.result.current).toBeNull();
    resetPortalCompanyNameCache();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const b = renderHook(() => usePortalCompanyName());
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(b.result.current).toBeNull();
  });
});
