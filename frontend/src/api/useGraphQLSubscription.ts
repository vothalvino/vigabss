// =============================================================================
// VigaBSS 5.0 — useGraphQLSubscription hook (P3.9)
// =============================================================================
// Connects to the graphql-yoga SSE subscription endpoint via EventSource.
// Sends the subscription query as GET params, parses data events, and cleans
// up on unmount.
//
// yoga frames every result as `event: next` and ends a stream with
// `event: complete`; listening only for 'message' meant no update ever
// arrived, and a denied subscription (200, an errors frame, complete) was
// reopened by EventSource for ever (GQL-05). Results are read from 'next',
// 'complete' or an errors frame ends the subscription, and only a transport
// error reconnects, with backoff.
//
// Authentication is the httpOnly access cookie (withCredentials): the token
// used to be added to the URL, where nginx and the request log recorded it
// (FE-12).
// =============================================================================

import { useState, useEffect, useMemo } from 'react';

const GQL_ENDPOINT = '/api/v1/graphql';
const MAX_BACKOFF_MS = 60_000;

export interface GraphQLSubscriptionResult<T> {
  data: T | null;
  error: string | null;
}

export function useGraphQLSubscription<T>(
  query: string,
  variables: Record<string, unknown> = {},
  { enabled = true }: { enabled?: boolean } = {},
): GraphQLSubscriptionResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serializedVars = useMemo(() => JSON.stringify(variables), [variables]);

  useEffect(() => {
    if (!enabled) return undefined;
    const params = new URLSearchParams();
    params.set('query', query);
    if (Object.keys(variables).length > 0) {
      params.set('variables', serializedVars);
    }
    const url = `${GQL_ENDPOINT}?${params.toString()}`;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
    };

    const open = () => {
      if (stopped) return;
      es = new EventSource(url, { withCredentials: true });
      const onResult = (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data as string) as { data?: T; errors?: Array<{ message: string }> };
          if (parsed.errors && parsed.errors.length > 0) {
            // A denied or failed subscription: reconnecting would only be
            // denied again.
            setError(parsed.errors[0].message);
            stop();
          } else if (parsed.data !== undefined) {
            attempt = 0;
            setData(parsed.data);
          }
        } catch (parseErr) {
          setError(`Failed to parse subscription event: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        }
      };
      es.addEventListener('next', onResult as EventListener);
      es.addEventListener('message', onResult as EventListener); // servers without named events
      es.addEventListener('complete', () => stop());
      es.addEventListener('error', () => {
        if (stopped) return;
        setError('Subscription connection error');
        // Take reconnection out of EventSource's hands: back off instead.
        es?.close();
        es = null;
        const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        retryTimer = setTimeout(open, delay);
      });
    };

    open();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, serializedVars, enabled]);

  return { data, error };
}
