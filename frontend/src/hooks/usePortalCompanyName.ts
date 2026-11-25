// Before a customer signs in the portal cannot know which company they belong
// to, unless the installation serves exactly one. The server answers with that
// one company's name, or nothing when there are several.
import { useEffect, useState } from 'react';

let cached: string | null | undefined;

export function resetPortalCompanyNameCache(): void {
  cached = undefined;
}

export function usePortalCompanyName(): string | null {
  const [name, setName] = useState<string | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    fetch('/api/v1/portal/brand', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { organization_name?: string | null } } | null) => {
        cached = json?.data?.organization_name?.trim() || null;
        if (alive) setName(cached);
      })
      .catch(() => { /* the plain "Customer portal" wording stays */ });
    return () => { alive = false; };
  }, []);
  return name;
}
