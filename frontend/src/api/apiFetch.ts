// =============================================================================
// JSON requests for pages that call REST paths by hand (FE-20)
// =============================================================================
// Sixteen pages each carried their own apiFetch. Some went through
// authedFetch; others used bare fetch with a token read from localStorage keys
// no build ever wrote, plus an X-Org-Id header the server ignores, so they sent
// `Authorization: Bearer ` and failed with a 401 instead of refreshing. Two
// called the unversioned /api. This is the one copy: authedFetch (cookie,
// CSRF and refresh-on-401), the /api/v1 prefix, and the server's error text.
// =============================================================================

import { authedFetch } from './client';
import { parseApiError } from './errors';

/** A non-2xx response; `status` is the HTTP status. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown = null) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** A path under /api/v1 ('/clients'), or a full '/api/...' URL as is. */
export function apiUrl(path: string): string {
  return path.startsWith('/api/') ? path : `/api/v1${path}`;
}

/**
 * Send a request and return the parsed JSON body (null for an empty one).
 * Throws ApiRequestError with the server's message on a non-2xx status.
 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await authedFetch(apiUrl(path), { ...init, headers });
  // 204 and empty or non-JSON bodies (a proxy's HTML error page) read as null.
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(parseApiError(body, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`), res.status, body);
  }
  return body as T;
}
