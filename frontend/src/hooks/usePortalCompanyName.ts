// Before a customer signs in the portal cannot know which company they belong
// to, unless the installation serves exactly one. The server answers with that
// one company's name and whether it has a logo, or nothing when there are
// several.
import { useEffect, useState } from 'react';
import { usePortalTabTitle } from './usePortalTabTitle';
import { usePortalTabIcon } from './usePortalTabIcon';

export interface PortalBrand {
  name: string | null;
  /** Address of the company's logo, readable without signing in. */
  logoUrl: string | null;
}

const UNKNOWN: PortalBrand = { name: null, logoUrl: null };
let cached: PortalBrand | undefined;

export function resetPortalCompanyNameCache(): void {
  cached = undefined;
}

export function usePortalBrand(): PortalBrand {
  const [brand, setBrand] = useState<PortalBrand>(cached ?? UNKNOWN);
  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    fetch('/api/v1/portal/brand', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { organization_name?: string | null; has_logo?: boolean } } | null) => {
        cached = {
          name: json?.data?.organization_name?.trim() || null,
          logoUrl: json?.data?.has_logo ? '/api/v1/portal/brand/logo' : null,
        };
        if (alive) setBrand(cached);
      })
      .catch(() => { /* the plain "Customer portal" wording stays */ });
    return () => { alive = false; };
  }, []);
  return brand;
}

export function usePortalCompanyName(): string | null {
  return usePortalBrand().name;
}

/** The sign-in pages: the company's name and logo in the browser tab when known. */
export function usePortalSignedOutBrand(): PortalBrand {
  const brand = usePortalBrand();
  usePortalTabTitle(brand.name);
  usePortalTabIcon(brand.logoUrl);
  return brand;
}
