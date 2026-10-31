// =============================================================================
// useClientNames — names for the clients a list page is showing (FE-04)
// =============================================================================
// Invoice, payment, ticket, contract and credit-note lists built their
// id -> name map from GET /clients?limit=500, which the server caps at the
// newest 100 clients, so every row for an older client showed a bare id.
// This asks for exactly the ids on the page (GET /clients?ids=…, archived
// clients included, since old documents still name them).
// =============================================================================

import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export function useClientNames(ids: Array<number | null | undefined>): Map<number, string> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number' && id > 0))]
    .sort((a, b) => a - b)
    .slice(0, 100);
  const { data } = useQuery({
    queryKey: ['client-names', unique],
    enabled: unique.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await api.GET('/clients', {
        params: { query: { ids: unique.join(','), include_deleted: 'true', limit: 100 } as never },
      });
      if (res.error) throw new Error('Failed to load client names');
      return ((res.data as unknown as { data: Array<{ id: number; name: string }> }).data ?? []);
    },
  });
  return new Map((data ?? []).map(c => [c.id, c.name]));
}
