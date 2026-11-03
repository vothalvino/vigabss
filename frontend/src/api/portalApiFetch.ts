// =============================================================================
// JSON requests for portal pages (FE-26)
// =============================================================================
// The portal counterpart of apiFetch: portalAuthedFetch (the subscriber's
// session and refresh), the /api/v1/portal prefix, and the server's error
// text. Older portal pages still carry a local copy.
// =============================================================================

import { portalAuthedFetch } from '@/auth/PortalAuthContext';
import { ApiRequestError } from './apiFetch';
import { parseApiError } from './errors';

export async function portalApiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await portalAuthedFetch(`/api/v1/portal${path}`, { ...init, headers });
  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiRequestError(parseApiError(body, `HTTP ${res.status}`), res.status, body);
  }
  return body as T;
}
