import type { QueryClient } from '@tanstack/react-query';

// Query keys for caches that other pages invalidate (FE2-14). A contract's
// status shows on its own page, in the contract list and on its client's
// page; with literal keys spread across pages, a status change refreshed only
// the page that made it and the others stayed stale for up to staleTime.
export const queryKeys = {
  contracts: {
    all: ['contracts'] as const,
    list: (...params: unknown[]) => ['contracts', ...params] as const,
    detail: (id: string | undefined) => ['contract-detail-gql', id] as const,
  },
  clients: {
    // Client ids come from route params (strings) and from records (numbers),
    // so cross-page invalidation goes by this prefix.
    allDetails: ['client-detail-gql'] as const,
    detail: (id: string | number | undefined) => ['client-detail-gql', id == null ? id : String(id)] as const,
  },
};

/** Refresh every view that shows a contract's status after it changes. */
export function invalidateContractViews(queryClient: QueryClient, contractId: string | undefined) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.contracts.detail(contractId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.clients.allDetails }),
  ]);
}
