// =============================================================================
// VigaBSS 5.0 — Portal Auth Service
// =============================================================================
// Handles authentication for the client self-service portal.
// Clients are NOT staff users — they authenticate with their email +
// a portal-specific password stored as a bcrypt hash on the clients table.
//
// Access JWTs issued here are signed with a portal-only key and carry
// { sub: clientId, type: 'portal', aud: 'vigabss-portal' } (see
// src/utils/accessTokens.js), so they cannot be used against staff endpoints,
// and staff tokens cannot be used against portal endpoints.
// =============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { UnauthorizedError, ValidationError } = require('../utils/errors');
const { signPortalAccessToken } = require('../utils/accessTokens');
const { revokePortalSessions } = require('./sessionRevocation');
const { isolatedOrganizationIds } = require('./organizationFanOut');

const SALT_ROUNDS = 12;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
// Portal accounts sharing one email that login and reset will consider.
const MAX_SHARED_EMAIL_ACCOUNTS = 10;
const ACCESS_SECONDS = 900;    // 15 minutes
const REFRESH_SECONDS = 604800; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

// A subscriber of an organization in isolated-database mode lives in that
// organization's database, not the primary (TNB-27). The public endpoints
// below know only an email or a token, so they search the primary and then
// each isolated organization's database. A row found on the primary for an
// isolated organization is a stale pre-cutover copy and is ignored; a row in a
// tenant database counts only for that organization. Each match carries
// `scopeOrgId` (null = primary) so its writes go back to the same database.
function inScope(scopeOrgId, callback) {
  if (scopeOrgId === null) {
    return typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(callback) : callback();
  }
  return db.withTenantContext(scopeOrgId, callback);
}

async function findAcrossScopes(lookup) {
  const [primaryRows] = await inScope(null, lookup);
  const isolated = await isolatedOrganizationIds();
  const found = primaryRows
    .filter(row => !isolated.includes(Number(row.organization_id)))
    .map(row => ({ ...row, scopeOrgId: null }));
  for (const orgId of isolated) {
    const [rows] = await inScope(orgId, lookup);
    for (const row of rows) {
      if (Number(row.organization_id) === orgId) found.push({ ...row, scopeOrgId: orgId });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// login — validate email + password, return tokens
// ---------------------------------------------------------------------------

let dummyHash = null;
async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash('vigabss-dummy-password', SALT_ROUNDS);
  await bcrypt.compare(String(password ?? ''), dummyHash);
}

async function login({ email, password }) {
  if (!email || !password) {
    throw new ValidationError('email and password are required');
  }

  const rows = await findAcrossScopes(() => db.query(
    `SELECT id, organization_id, name, email, status,
            portal_password_hash, portal_login_attempts, portal_locked_until, portal_token_version
     FROM clients
     WHERE email = ? AND deleted_at IS NULL
     LIMIT ?`,
    [email.toLowerCase().trim(), MAX_SHARED_EMAIL_ACCOUNTS + 1],
  ));

  // One answer, after the same bcrypt work, for an unknown email, an inactive
  // client, a client without portal access and a locked account, so neither
  // the message nor the timing reveals which (SEC-11). A locked account is not
  // checked against the password, and failures during a lock do not extend it.
  const invalidCreds = () => new UnauthorizedError('Invalid email or password');
  const isLocked = c => c.portal_locked_until && new Date(c.portal_locked_until) > new Date();

  // An email is not unique across clients (a family, a business with several
  // accounts, two ISPs on one install), and treating two rows as a miss locked
  // every one of them out of the portal for good (WHK-10). The password picks
  // the account: it is checked against each portal-enabled candidate, and the
  // login succeeds only when exactly one matches. Two matches stay ambiguous
  // and fail closed.
  const candidates = rows.length <= MAX_SHARED_EMAIL_ACCOUNTS
    ? rows.filter(c => c.status !== 'inactive' && c.portal_password_hash && !isLocked(c))
    : [];
  if (!candidates.length) {
    await burnPasswordCheck(password);
    throw invalidCreds();
  }

  const matches = [];
  for (const candidate of candidates) {
    if (await bcrypt.compare(password, candidate.portal_password_hash)) matches.push(candidate);
  }
  if (matches.length > 1) throw invalidCreds();

  if (!matches.length) {
    // Atomic, and an expired lock restarts the count (see authService). Every
    // candidate the password was tried against counts the failure.
    for (const candidate of candidates) {
      await inScope(candidate.scopeOrgId, () => db.query(
        `UPDATE clients SET
           portal_login_attempts = CASE WHEN portal_locked_until IS NOT NULL AND portal_locked_until <= NOW() THEN 1
                                        ELSE portal_login_attempts + 1 END,
           portal_locked_until = CASE WHEN portal_locked_until IS NOT NULL AND portal_locked_until > NOW() THEN portal_locked_until
                                      WHEN portal_login_attempts >= ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
                                      ELSE NULL END
         WHERE id = ?`,
        [MAX_ATTEMPTS, LOCKOUT_MINUTES, candidate.id],
      ));
    }
    throw invalidCreds();
  }
  const [client] = matches;
  return inScope(client.scopeOrgId, () => issueLoginTokens(client));
}

async function issueLoginTokens(client) {
  // Reset lockout on success
  await db.query(
    'UPDATE clients SET portal_login_attempts = 0, portal_locked_until = NULL WHERE id = ?',
    [client.id],
  );

  // Issue tokens
  const accessToken = signPortalAccessToken(
    { clientId: client.id, organizationId: client.organization_id, tokenVersion: client.portal_token_version },
    ACCESS_SECONDS,
  );

  const refreshToken = generateRefreshToken();
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000);

  await db.query(
    `INSERT INTO portal_refresh_tokens (client_id, token_hash, expires_at)
     VALUES (?, ?, ?)`,
    [client.id, tokenHash, expiresAt],
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_SECONDS,
    client: {
      id: client.id,
      name: client.name,
      email: client.email,
      organization_id: client.organization_id,
    },
  };
}

// ---------------------------------------------------------------------------
// refreshToken — exchange a refresh token for a new access token
// ---------------------------------------------------------------------------

async function refreshToken(token) {
  if (!token) throw new UnauthorizedError('Refresh token required');

  const hash = crypto.createHash('sha256').update(token).digest('hex');

  const rows = await findAcrossScopes(() => db.query(
    `SELECT prt.*, c.id AS client_id, c.organization_id, c.name, c.email, c.status, c.portal_token_version
     FROM portal_refresh_tokens prt
     JOIN clients c ON c.id = prt.client_id
     WHERE prt.token_hash = ?
       AND prt.revoked_at IS NULL
       AND prt.expires_at > NOW()
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [hash],
  ));

  if (rows.length === 0) throw new UnauthorizedError('Invalid or expired refresh token');

  return inScope(rows[0].scopeOrgId, () => rotateRefreshToken(rows[0]));
}

async function rotateRefreshToken(row) {

  if (row.status === 'inactive') {
    throw new UnauthorizedError('Account is not active');
  }

  const newAccessToken = signPortalAccessToken(
    { clientId: row.client_id, organizationId: row.organization_id, tokenVersion: row.portal_token_version },
    ACCESS_SECONDS,
  );

  const newRefreshToken = generateRefreshToken();
  const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000);

  // Rotate: revoke old, issue new — one transaction, mirroring the staff-side
  // authService rotation. The `revoked_at IS NULL` guard + affectedRows check
  // is the atomic claim: two concurrent redeems of the same one-shot token
  // (portal open in two tabs, both bootstrapping) can no longer BOTH pass the
  // SELECT above and mint two live token pairs. The transaction also rolls
  // the revocation back if the INSERT fails, so a DB blip mid-rotation
  // doesn't leave the subscriber with zero valid refresh tokens.
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.execute(
      'UPDATE portal_refresh_tokens SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL',
      [row.id],
    );
    if (!claim || claim.affectedRows === 0) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
    await conn.execute(
      'INSERT INTO portal_refresh_tokens (client_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [row.client_id, newHash, expiresAt],
    );
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already unusable */ }
    throw err;
  } finally {
    conn.release();
  }

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// logout — revoke a refresh token
// ---------------------------------------------------------------------------

async function logout(token) {
  if (!token) return;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const revoke = () => db.query(
    'UPDATE portal_refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?',
    [hash],
  );
  await inScope(null, revoke);
  for (const orgId of await isolatedOrganizationIds()) await inScope(orgId, revoke);
}

// ---------------------------------------------------------------------------
// setPassword — (re-)set the portal password for a client (admin action)
// ---------------------------------------------------------------------------

async function setPassword(clientId, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('Portal password must be at least 8 characters');
  }
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.query(
    'UPDATE clients SET portal_password_hash = ?, portal_login_attempts = 0, portal_locked_until = NULL WHERE id = ?',
    [hash, clientId],
  );
  // A new password ends every portal session — staff setting it and the
  // subscriber changing it alike — including access tokens already issued (SEC-10).
  await revokePortalSessions(clientId);
}

// ---------------------------------------------------------------------------
// requestPasswordReset — generate + store a reset token (caller emails it)
// ---------------------------------------------------------------------------
//
// Anti-enumeration + never-a-self-enablement-path: a token is only ever
// generated when the matched client (a) exists, (b) has portal access
// already enabled (portal_password_hash IS NOT NULL — that column is a
// deliberate admin control; see login()'s distinct "not enabled" error
// above), and (c) is not inactive. All other cases return the IDENTICAL
// generic message with no token, so "forgot password" can never become a
// silent self-activation path for a portal account the ISP has not turned
// on — mirroring authService.requestPasswordReset's shape exactly.
// ---------------------------------------------------------------------------

async function requestPasswordReset(email) {
  const rows = await findAcrossScopes(() => db.query(
    `SELECT id, organization_id, name, email, status, portal_password_hash
     FROM clients
     WHERE email = ? AND deleted_at IS NULL
     LIMIT ?`,
    [email.toLowerCase().trim(), MAX_SHARED_EMAIL_ACCOUNTS + 1],
  ));

  const generic = { message: 'If that email exists, a reset link has been sent' };
  // Client email is not globally unique. Each portal-enabled account at the
  // address gets its own reset token (and its own email, sent by the caller
  // through that account's organization), so a shared address no longer
  // blocks reset for all of them (WHK-10). A token resets only the account it
  // was minted for.
  if (rows.length > MAX_SHARED_EMAIL_ACCOUNTS) return generic;
  const eligible = rows.filter(c => c.portal_password_hash && c.status !== 'inactive');

  const resets = [];
  for (const client of eligible) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [updated] = await inScope(client.scopeOrgId, () => db.query(
      `UPDATE clients SET portal_reset_token_hash = ?, portal_reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR)
       WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL`,
      [tokenHash, client.id, client.organization_id],
    ));
    if (updated.affectedRows !== 1) continue;
    resets.push({
      token,
      email: client.email,
      clientId: client.id,
      organizationId: client.organization_id,
      userName: client.name,
    });
  }
  return resets.length ? { ...generic, resets } : generic;
}

// ---------------------------------------------------------------------------
// mintPortalInvite — operator-initiated portal enablement (activation flow)
// ---------------------------------------------------------------------------
// DELIBERATELY different from requestPasswordReset above: that public endpoint
// must never enable an account (portal_password_hash is an admin control, and
// its anti-enumeration branch enforces exactly that). This function is only
// called from server-side flows that ARE the ISP's decision to hand the client
// portal access — today the service-order activation (welcome email). It mints
// a set-password token regardless of whether a password exists yet; redeeming
// it through resetPassword() is what enables the account.
// 7-day expiry, not the reset flow's 1 hour: a welcome email is read at the
// subscriber's leisure, not in a password-panic.
// ---------------------------------------------------------------------------

async function mintPortalInvite(clientId) {
  const [rows] = await db.query(
    'SELECT id, email, status FROM clients WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [clientId],
  );
  const client = rows[0];
  if (!client || !client.email || client.status === 'inactive') return null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    `UPDATE clients SET portal_reset_token_hash = ?, portal_reset_token_expires = DATE_ADD(NOW(), INTERVAL 7 DAY)
     WHERE id = ?`,
    [tokenHash, client.id],
  );
  return token;
}

// ---------------------------------------------------------------------------
// resetPassword — redeem a portal reset token for a new password
// ---------------------------------------------------------------------------

async function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const rows = await findAcrossScopes(() => db.query(
    `SELECT * FROM clients
     WHERE portal_reset_token_hash = ? AND portal_reset_token_expires > NOW() AND deleted_at IS NULL
     LIMIT 2`,
    [tokenHash],
  ));

  if (rows.length !== 1) {
    throw new UnauthorizedError('Invalid or expired reset token');
  }

  return inScope(rows[0].scopeOrgId, () => redeemResetToken(rows[0], tokenHash, newPassword));
}

async function redeemResetToken(client, tokenHash, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // Clear the reset token AND the brute-force lockout: possession of the
  // emailed reset token is stronger proof of identity than a password, so a
  // successful reset should also break the portal_login_attempts/
  // portal_locked_until loop from login()'s lockout logic — mirroring
  // authService.resetPassword's lockout-clear.
  const [updated] = await db.query(
    `UPDATE clients
        SET portal_password_hash = ?, portal_reset_token_hash = NULL, portal_reset_token_expires = NULL,
            portal_login_attempts = 0, portal_locked_until = NULL
      WHERE id = ? AND organization_id <=> ?
        AND portal_reset_token_hash = ? AND portal_reset_token_expires > NOW()
        AND deleted_at IS NULL`,
    [passwordHash, client.id, client.organization_id, tokenHash],
  );
  if (updated.affectedRows !== 1) {
    throw new UnauthorizedError('Invalid or expired reset token');
  }

  // Invalidate all outstanding refresh tokens — the portal's equivalent of
  // the staff flow's `DELETE FROM user_sessions`.
  await db.query(
    'UPDATE portal_refresh_tokens SET revoked_at = NOW() WHERE client_id = ? AND revoked_at IS NULL',
    [client.id],
  );
  // A reset is how a subscriber recovers a compromised account: the WhatsApp
  // numbers bound to it are unlinked too (SUP-04).
  await require('./whatsappService').revokeClientLinks({
    clientId: client.id, organizationId: client.organization_id ?? null, reason: 'portal_password_reset',
  });

  return { message: 'Password reset successfully' };
}

module.exports = { login, refreshToken, logout, setPassword, requestPasswordReset, mintPortalInvite, resetPassword };
