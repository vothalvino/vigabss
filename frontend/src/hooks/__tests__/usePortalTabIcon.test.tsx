import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePortalTabIcon } from '../usePortalTabIcon';

const icon = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]');

describe('usePortalTabIcon', () => {
  beforeEach(() => {
    document.head.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', '/icons/portal.svg');
    link.setAttribute('type', 'image/svg+xml');
    document.head.appendChild(link);
  });

  it('shows the company logo and puts the plain icon back on leaving', () => {
    const { unmount } = renderHook(() => usePortalTabIcon('data:image/png;base64,AAAA'));
    expect(icon()?.getAttribute('href')).toBe('data:image/png;base64,AAAA');
    expect(icon()?.hasAttribute('type')).toBe(false);
    unmount();
    expect(icon()?.getAttribute('href')).toBe('/icons/portal.svg');
    expect(icon()?.getAttribute('type')).toBe('image/svg+xml');
  });

  it('leaves the icon alone when the company has no logo', () => {
    renderHook(() => usePortalTabIcon(null));
    expect(icon()?.getAttribute('href')).toBe('/icons/portal.svg');
  });

  it('adds an icon when the page has none, and removes it again', () => {
    icon()?.remove();
    const { unmount } = renderHook(() => usePortalTabIcon('/api/v1/portal/brand/logo'));
    expect(icon()?.getAttribute('href')).toBe('/api/v1/portal/brand/logo');
    unmount();
    expect(icon()).toBeNull();
  });
});
