import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePortalTabTitle } from '../usePortalTabTitle';

describe('usePortalTabTitle', () => {
  beforeEach(() => { document.title = 'Staff app'; });

  it('shows the company name when it is known', () => {
    renderHook(() => usePortalTabTitle('Red Norte'));
    expect(document.title).toBe('Red Norte');
  });

  it('never shows the software name when the company is unknown', () => {
    renderHook(() => usePortalTabTitle(null));
    expect(document.title).not.toMatch(/viga/i);
    expect(document.title).not.toBe('Staff app');
  });

  it('switches to the company name once it loads, and restores the old title on leaving', () => {
    const { rerender, unmount } = renderHook(({ name }: { name?: string }) => usePortalTabTitle(name), {
      initialProps: { name: undefined as string | undefined },
    });
    rerender({ name: 'Red Norte' });
    expect(document.title).toBe('Red Norte');
    unmount();
    expect(document.title).toBe('Staff app');
  });
});
