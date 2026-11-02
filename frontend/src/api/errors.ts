// =============================================================================
// API error text (FE-18)
// =============================================================================
// The central error handler replies `{ error: { code, message, details? } }`,
// while some route-local handlers still reply `{ error: 'text' }`. Call sites
// that cast the body as `{ error?: string }` passed the object form to
// `new Error(...)`, so operators saw "[object Object]" instead of the server's
// explanation. Every error body is read through parseApiError.
// =============================================================================

/**
 * The human-readable message of an API error body: validation details first,
 * then the error message (object or string form), then a top-level message.
 */
export function parseApiError(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; details?: unknown };
    if (Array.isArray(e.details)) {
      const details = e.details
        .map((d) => (d && typeof d === 'object' ? (d as { message?: unknown }).message : undefined))
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
        .join(', ');
      if (details) return details;
    }
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  if (typeof message === 'string' && message) return message;
  return fallback;
}
