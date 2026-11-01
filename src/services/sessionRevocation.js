// =============================================================================
// VigaBSS 5.0 — revoke every session of a staff user or portal client (SEC-10)
// =============================================================================
// Deleting refresh sessions alone left every access JWT already issued valid
// until it expired. Each account carries a token version (migration 482) that
// is embedded in its access tokens and compared on every request; bumping it
// ends those tokens immediately.
// =============================================================================

const db = require('../config/database');

/**
 * End every session of a staff user: outstanding access tokens and refresh
 * sessions alike.
 * @param {number} userId
 * @param {(sql: string, params: unknown[]) => Promise<unknown>} [exec] a
 *   transaction's query function, so the revocation commits with the change.
 */
async function revokeUserSessions(userId, exec = (sql, params) => db.query(sql, params)) {
  await exec('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
  await exec('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
}

/** End every portal session of a client. */
async function revokePortalSessions(clientId, exec = (sql, params) => db.query(sql, params)) {
  await exec('UPDATE clients SET portal_token_version = portal_token_version + 1 WHERE id = ?', [clientId]);
  await exec('UPDATE portal_refresh_tokens SET revoked_at = NOW() WHERE client_id = ? AND revoked_at IS NULL', [clientId]);
}

/** True when an access token's version no longer matches the account's. */
function tokenVersionStale(payloadVersion, currentVersion) {
  return Number(payloadVersion ?? 0) !== Number(currentVersion ?? 0);
}

module.exports = { revokeUserSessions, revokePortalSessions, tokenVersionStale };
