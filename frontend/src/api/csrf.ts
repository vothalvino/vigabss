/**
 * Read the non-httpOnly `vigabss_csrf` cookie that the server sets after every
 * successful login or token refresh.  The value must be echoed back as the
 * `X-CSRF-Token` request header on any state-changing request that is
 * authenticated via the httpOnly `vigabss_refresh` cookie (i.e. the silent
 * token-refresh flow which carries no Bearer token).
 *
 * Returns an empty string when the cookie is absent or when called outside a
 * browser context (SSR / Node test environments).
 */
export function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)vigabss_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : '';
}
