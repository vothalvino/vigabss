// =============================================================================
// Response envelope helpers (FE2-01)
// =============================================================================
// Several network pages read response shapes the routes do not send, during
// render, so a TypeError unmounted the whole SPA:
//   - `query.data?.meta.total` on list routes that reply `{ data }` with no
//     meta (wireless AP sectors, channel plans, interference, AP commands;
//     data-cap policies, FUP notifications; bandwidth test servers) or
//     `{ data, total, page, limit }` (link planning, spectrum scans);
//   - single-object helpers that returned the `{ data: … }` body itself as
//     the payload (PON utilization and ONUs, SFP diagnostics, signal
//     distribution, the link calculator);
//   - `.toFixed` on MySQL DECIMAL values, which arrive as strings.
// =============================================================================

/** Row count of a list response: meta.total, a top-level total, or the rows. */
export function listTotal(body: unknown): number {
  if (!body || typeof body !== 'object') return 0;
  const b = body as { meta?: { total?: unknown }; total?: unknown; data?: unknown };
  const total = b.meta?.total ?? b.total;
  if (total !== undefined && total !== null && Number.isFinite(Number(total))) return Number(total);
  return Array.isArray(b.data) ? b.data.length : 0;
}

/** The payload of a `{ data: … }` response body (the body itself if unwrapped). */
export function unwrapData<T>(body: unknown): T {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/** A number (or numeric string) with fixed decimals; '—' when missing. */
export function fmtFixed(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}
