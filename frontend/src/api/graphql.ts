// =============================================================================
// VigaBSS 5.0 — GraphQL Client Helper (P3.3)
// =============================================================================
// Thin wrapper around graphql-request that automatically attaches the current
// JWT access token and points at the /api/v1/graphql endpoint.
//
// Usage:
//   import { gql } from '@/api/graphql';
//   const data = await gql<{ client: Client }>(`query { client(id: $id) { name } }`, { id: '1' });
// =============================================================================

import { GraphQLClient } from 'graphql-request';
import { authedFetch } from './client';

function getClient(): GraphQLClient {
  // IMPORTANT: when a custom `fetch` is supplied, graphql-request constructs a
  // `new URL(endpoint)`, which throws on a RELATIVE path ("Invalid URL:
  // /api/v1/graphql") BEFORE any request is sent — so the query silently failed
  // and the page showed "Client not found". Use an absolute, same-origin URL.
  const endpoint = `${window.location.origin}/api/v1/graphql`;
  // Route through authedFetch so GraphQL shares the REST client's token-attach +
  // CSRF header + silent-refresh-on-401 + retry. Reading the token per-request
  // (inside authedFetch) lets a request made right after a page reload (empty
  // in-memory token) recover instead of failing.
  return new GraphQLClient(endpoint, {
    credentials: 'include',
    fetch: authedFetch,
    // GQL-07: with the default 'none', any error in a 200 response threw, so
    // one failing nested field (invoices on a client page) blanked the whole
    // page as "not found". 'all' keeps the data the server did return.
    errorPolicy: 'all',
  });
}

/**
 * Execute a GraphQL document against the VigaBSS API.
 * Automatically attaches the current access token.
 *
 * Returns the data even when some fields failed (they come back null or
 * empty); throws only when the response carries no data at all.
 */
export async function gql<T = unknown>(
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { data, errors } = await getClient().rawRequest<T>(document, variables);
  if (data === null || data === undefined) {
    throw new Error(errors?.[0]?.message || 'GraphQL request returned no data');
  }
  if (errors?.length) {
    console.warn('GraphQL returned partial data:', errors.map(e => e.message).join('; '));
  }
  return data;
}
