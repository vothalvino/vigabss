// The browser tab icon on the pages a company's customers open: the company's
// logo when it has one. Without a logo the page keeps the plain icon it
// arrived with. The previous icon comes back when the screen goes away.
import { useEffect } from 'react';

export function usePortalTabIcon(href?: string | null): void {
  useEffect(() => {
    if (!href) return undefined;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const created = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    const previous = { href: link.getAttribute('href'), type: link.getAttribute('type') };
    link.removeAttribute('type');
    link.setAttribute('href', href);
    const el = link;
    return () => {
      if (created) { el.remove(); return; }
      if (previous.href) el.setAttribute('href', previous.href);
      if (previous.type) el.setAttribute('type', previous.type);
    };
  }, [href]);
}
