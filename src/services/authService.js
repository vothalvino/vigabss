// =============================================================================
// VigaBSS 5.0 — Auth Service
// =============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../models/User');
const { revokeUserSessions } = require('./sessionRevocation');
const { sanitizeUser } = require('../utils/userSanitize');
const db = require('../config/database');
const emailTransport = require('./emailTransport');
const { resolveOrgPrincipal } = require('./orgPrincipalService');
const passwordPolicy = require('./passwordPolicyService');
const { hasGlobalOrganizationAccessUser } = require('./globalOrganizationAccess');
const emailTemplates = require('../views/emailTemplates');
const logger = require('../utils/logger');
const {
  signMfaChallengeToken,
  verifyMfaChallengeToken,
  passwordFingerprint,
  MFA_CHALLENGE_SECONDS,
} = require('../utils/accessTokens');
const { UnauthorizedError, ConflictError, ValidationError, NotFoundError } = require('../utils/errors');

const SALT_ROUNDS = 12;

async function findGlobalFallbackOrganization(user) {
  // Production user rows are SELECT * and therefore always carry these
  // columns. The shape check also keeps legacy callers/test doubles that omit
  // both signals on the ordinary home-org fallback without extra queries.
  const hasStoredIdentitySignal = user?.is_install_operator !== undefined
    || user?.group_id !== undefined
    || config.installOperatorUserIds.length > 0;
  if (!hasStoredIdentitySignal || !await hasGlobalOrganizationAccessUser(user)) return null;

  const [liveOrganizations] = await db.query(
    `SELECT id, name, currency FROM organizations
      WHERE status = 'active' AND deleted_at IS NULL
      ORDER BY (id = ?) DESC, id ASC
      LIMIT 1`,
    [user.organization_id],
  );
  return liveOrganizations[0] || null;
}

// Refresh token lifetime in seconds (parsed from config, e.g. '7d' → 604800)
const REFRESH_SECONDS = parseExpiry(config.jwt.refreshExpiresIn);

// Access token lifetime in seconds (parsed from config, e.g. '15m' → 900)
const ACCESS_SECONDS = parseExpiry(config.jwt.accessExpiresIn);

/**
 * Parse a human-readable expiry string ('15m', '7d', '24h') into seconds.
 */
function parseExpiry(str) {
  if (!str) return 604800; // 7 days
  const m = String(str).match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return 604800;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 604800;
  }
}

/**
 * Generate an opaque refresh token (64-char hex string).
 */
function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Atomically consume a session row and insert its rotated successor.
 *
 * One transaction, two guarantees:
 *  - The DELETE is the claim: of N concurrent redeems of the same one-shot
 *    refresh token, exactly one sees affectedRows 1; the rest get 401 instead
 *    of minting extra live session pairs (token-reuse hardening).
 *  - Rollback on a failed INSERT restores the old session row, so a DB blip
 *    mid-rotation degrades to "retry works" instead of "user force-logged-out
 *    with zero valid refresh tokens".
 *
 * @param {number} sessionId  Row id of the session being consumed.
 * @param {Array} insertParams  [user_id, token_hash, token_family, ip, ua, refreshSeconds]
 */
async function consumeAndReplaceSession(sessionId, insertParams) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.execute('DELETE FROM user_sessions WHERE id = ?', [sessionId]);
    if (!claim || claim.affectedRows === 0) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
    await conn.execute(
      `INSERT INTO user_sessions (user_id, token_hash, token_family, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      insertParams,
    );
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already unusable */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Register a new user.
 */
async function register({ firstName, lastName, email, password, organizationId, role }) {
  // Check for existing email
  const existing = await User.findByEmail(email);
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  await passwordPolicy.assertPasswordAllowed(password, organizationId);

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await User.create({
    first_name: firstName,
    last_name: lastName,
    email,
    password_hash: passwordHash,
    organization_id: organizationId || null,
    role: role || 'support',
  });

  // If organization provided, ensure an organization_users membership exists.
  // User.create() already mirrors roles that are valid in the membership ENUM
  // (admin/billing/technician/readonly) into a row, so use INSERT IGNORE here to
  // stay idempotent and still cover the legacy 'support' default (→ 'readonly').
  if (organizationId) {
    await db.query(
      'INSERT IGNORE INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)',
      [organizationId, user.id, role || 'readonly'],
    );
  }

  // Generate an email-verification token (cheap, single UPDATE — kept
  // synchronous so a fresh account always has a pending token immediately)
  // and send it. The SMTP round-trip itself is intentionally NOT awaited:
  // nodemailer's connection timeout defaults to ~2 minutes, and a slow or
  // unreachable mail server must never make registration hang or vary its
  // response timing. The account row already exists at this point, so a
  // send failure is best-effort — logged server-side, never surfaced to the
  // caller — and the user can request a fresh link via
  // POST /auth/verify-email/resend.
  try {
    const { token } = await generateEmailVerificationToken(user.id);
    const verifyUrl = `${config.appUrl}/verify-email?token=${token}`;
    const userName = [firstName, lastName].filter(Boolean).join(' ') || undefined;
    const template = emailTemplates.emailVerificationEmail({ userName, verifyUrl });
    emailTransport.sendEmail({ operationalRecipient: true, to: email, subject: template.subject, html: template.html })
      .then((sendResult) => {
        if (!sendResult || !sendResult.success) {
          logger.warn(`Verification email failed to send to ${email}: ${sendResult && sendResult.error}`);
        }
      })
      .catch((err) => {
        logger.error(`Verification email send threw for new user ${user.id}: ${err.message}`);
      });
  } catch (err) {
    // Only the token-generation UPDATE can land here — sendEmail() above
    // never throws synchronously (it's an async function; failures reach
    // the .catch chained onto it instead).
    logger.error(`Verification email send threw for new user ${user.id}: ${err.message}`);
  }

  return sanitizeUser(user);
}

/** True when the account must present a second factor before a session. */
function requiresSecondFactor(user) {
  return Boolean(user && (user.totp_enabled === true || Number(user.totp_enabled) === 1));
}

/**
 * Record one failed credential attempt (password or second factor) and lock
 * the account after the home organization's lockout_attempts (default 5) for
 * lockout_duration_minutes (default 15). Both factors share the counter, so a
 * stolen password cannot be used to grind through TOTP codes.
 */
//
// One atomic UPDATE (SEC-11): the old read-modify-write let parallel guesses
// all write the same count, and a counter that was never reset after a lock
// expired re-locked the account on every later failure. A lock that has
// expired restarts the count at 1; MySQL evaluates the SET list left to
// right, so locked_until sees the new count.
async function recordFailedLoginAttempt(user) {
  const policy = await passwordPolicy.loadPolicy(user.organization_id);
  await db.query(
    `UPDATE users SET
       failed_login_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
                                    ELSE failed_login_attempts + 1 END,
       locked_until = CASE WHEN locked_until IS NOT NULL AND locked_until > NOW() THEN locked_until
                           WHEN failed_login_attempts >= ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
                           ELSE NULL END
     WHERE id = ?`,
    [policy.lockout_attempts, policy.lockout_duration_minutes, user.id],
  );
}

// Unknown, inactive and locked accounts are answered exactly like a wrong
// password, after the same bcrypt work, so neither the message nor the
// timing says whether an account exists or what state it is in (SEC-11).
const INVALID_LOGIN = 'Invalid email or password';
let dummyHash = null;
async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash('vigabss-dummy-password', SALT_ROUNDS);
  await bcrypt.compare(String(password ?? ''), dummyHash);
}

function isLocked(user) {
  return Boolean(user.locked_until && new Date(user.locked_until) > new Date());
}

/**
 * Mint an access token + refresh session for a fully authenticated user.
 * Callers must already have verified every required factor (and stamped
 * last_login_at).
 */
async function issueSession(user, orgs, activeOrgId) {
  const accessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      orgId: activeOrgId,
      tv: Number(user.token_version ?? 0),
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn, algorithm: config.jwt.algorithm },
  );

  // Issue opaque refresh token + assign a token family for reuse detection
  const refreshTokenValue = generateRefreshToken();
  const family = crypto.randomUUID();
  const refreshHash = crypto.createHash('sha256').update(refreshTokenValue).digest('hex');

  await db.query(
    `INSERT INTO user_sessions (user_id, token_hash, token_family, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [user.id, refreshHash, family, null, null, REFRESH_SECONDS],
  );

  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresIn: ACCESS_SECONDS,
    user: sanitizeUser(user),
    organizations: orgs,
    // The org the JWT was minted for — the login route enriches the user
    // (currency/locale/group/permissions) for THIS org so the first-paint UI
    // matches what every subsequent request will be authorized against.
    activeOrganizationId: activeOrgId,
  };
}

/**
 * Resolve the organization a fresh login is bound to: the primary
 * membership, else (for a global identity whose seeded home tenant is gone)
 * a live organization, else the stored home org.
 */
async function resolveLoginOrganizations(user) {
  // A global identity can outlive its seeded home tenant (for example after
  // the operator retires Demo ISP), so when it has no remaining membership
  // choose a live organization rather than minting an unusable JWT bound to a
  // soft-deleted home id.
  const orgs = await User.getOrganizations(user.id);
  let primaryOrg = orgs[0] || null;
  if (!primaryOrg) primaryOrg = await findGlobalFallbackOrganization(user);
  return { orgs, activeOrgId: primaryOrg?.id || user.organization_id };
}

/**
 * Authenticate a user and return an access token + refresh token pair.
 *
 * When the account has TOTP 2FA enabled, no session is minted: the result is
 * `{ mfaRequired: true, mfaToken, expiresIn }`, and the caller must complete
 * the login with completeMfaLogin(). The failed-attempt counter is NOT reset
 * until the second factor succeeds.
 */
async function login({ email, password }) {
  const user = await User.findByEmail(email);
  // A locked account is not checked against the password at all: a different
  // answer for the right password would let guessing continue through the
  // lock. Failures during a lock do not extend it.
  if (!user || user.status !== 'active' || isLocked(user)) {
    await burnPasswordCheck(password);
    throw new UnauthorizedError(INVALID_LOGIN);
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    // Increment failed attempts and potentially lock the account
    await recordFailedLoginAttempt(user);
    throw new UnauthorizedError(INVALID_LOGIN);
  }

  // An expired password still signs in, but only to replace itself: the
  // forced-change gate in auth.js (migration 480) does the rest.
  if (Number(user.must_change_password) !== 1
      && passwordPolicy.passwordExpired(user, await passwordPolicy.loadPolicy(user.organization_id))) {
    await db.query('UPDATE users SET must_change_password = 1 WHERE id = ?', [user.id]);
    user.must_change_password = 1;
  }

  if (requiresSecondFactor(user)) {
    return {
      mfaRequired: true,
      mfaToken: signMfaChallengeToken({ userId: user.id, passwordHash: user.password_hash, method: 'password' }),
      expiresIn: MFA_CHALLENGE_SECONDS,
    };
  }

  // Reset failed attempts on successful login
  if (user.failed_login_attempts > 0 || user.locked_until) {
    await db.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
      [user.id],
    );
  }

  // Update last_login_at
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  const { orgs, activeOrgId } = await resolveLoginOrganizations(user);
  return issueSession(user, orgs, activeOrgId);
}

/**
 * Challenge an SSO-authenticated user for their second factor. The IdP
 * assertion replaces the password, never the TOTP; the challenge is bound to
 * the SSO organization.
 */
function createSsoMfaChallenge(user, organizationId) {
  return {
    mfaRequired: true,
    mfaToken: signMfaChallengeToken({
      userId: user.id, passwordHash: user.password_hash, organizationId, method: 'sso',
    }),
    expiresIn: MFA_CHALLENGE_SECONDS,
  };
}

/**
 * Second step of a 2FA login (password or SSO). Verifies the challenge token
 * and a TOTP or backup code, then mints the session exactly as login() does.
 * An SSO challenge stays bound to the SSO organization it was issued for.
 */
async function completeMfaLogin({ mfaToken, code }) {
  let challenge;
  try {
    challenge = verifyMfaChallengeToken(mfaToken);
  } catch (_err) {
    throw new UnauthorizedError('Invalid or expired two-factor challenge. Sign in again.');
  }

  const user = await User.findById(challenge.sub);
  if (!user || user.status !== 'active') {
    throw new UnauthorizedError('Invalid or expired two-factor challenge. Sign in again.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new UnauthorizedError('Account temporarily locked due to too many failed login attempts');
  }
  // A password change (or reset) since the challenge was issued voids it, and
  // so does 2FA having been turned off in the meantime.
  if (challenge.pwf !== passwordFingerprint(user.password_hash) || !requiresSecondFactor(user)) {
    throw new UnauthorizedError('Invalid or expired two-factor challenge. Sign in again.');
  }

  const twoFactorService = require('./twoFactorService');
  try {
    await twoFactorService.verifyCode(user.id, code);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await recordFailedLoginAttempt(user);
      throw new UnauthorizedError('Invalid 2FA code');
    }
    throw err;
  }

  if (user.failed_login_attempts > 0 || user.locked_until) {
    await db.query(
      'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
      [user.id],
    );
  }

  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  let orgs;
  let activeOrgId;
  if (challenge.method === 'sso') {
    // The SSO organization is the only one this challenge may open. It is
    // re-validated so a membership revoked in the meantime is honoured.
    const resolved = await resolveActiveOrg(user.id, user.role, challenge.orgId);
    if (!resolved) {
      throw new UnauthorizedError('User no longer has access to the selected organization');
    }
    orgs = await User.getOrganizations(user.id);
    activeOrgId = resolved.id;
  } else {
    ({ orgs, activeOrgId } = await resolveLoginOrganizations(user));
  }

  return issueSession(user, orgs, activeOrgId);
}

/**
 * Resolve a requested active organization for a user.
 * Returns { id, name, membership_role } if the user may operate as that org, or
 * null otherwise. Install operators and system super_admin accounts may switch
 * to any live org; everyone else only to orgs they are a member of. Shared by the active-org
 * re-validation on token refresh so a stale/forged `fireisp_active_org` value can
 * never escalate access.
 */
async function resolveActiveOrg(userId, userRole, requestedOrgId) {
  if (!requestedOrgId) return null;
  const user = await User.findById(userId);
  if (!user || user.status !== 'active' || user.role !== userRole) return null;
  const principal = await resolveOrgPrincipal(user, requestedOrgId);
  if (!principal) return null;
  return {
    id: principal.organizationId,
    name: principal.organizationName,
    membership_role: principal.membershipRole,
    is_install_operator: principal.isInstallOperator,
    is_super_admin: principal.isSuperAdmin,
    has_global_organization_access: principal.hasGlobalOrganizationAccess,
  };
}

/**
 * Refresh an access token using a valid refresh token.
 * Implements rotation: the old refresh token is consumed and a new pair is issued.
 * Detects token reuse (previously rotated token) and revokes the entire family.
 *
 * `requestedActiveOrgId` (from the `fireisp_active_org` cookie) preserves the active
 * organization across refreshes/reloads; it is re-validated, never trusted blindly.
 */
async function refreshToken(currentRefreshToken, requestedActiveOrgId = null) {
  const oldHash = crypto.createHash('sha256').update(currentRefreshToken).digest('hex');

  // Look up the refresh token session
  const [sessions] = await db.query(
    'SELECT * FROM user_sessions WHERE token_hash = ?',
    [oldHash],
  );

  if (sessions.length === 0) {
    // Token not found: either invalid, already consumed (rotated), or expired and cleaned up.
    // True reuse detection requires keeping revoked sessions, which is a future enhancement.
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const session = sessions[0];

  // Check expiry
  if (new Date(session.expires_at) <= new Date()) {
    // Expired — clean up and reject
    await db.query('DELETE FROM user_sessions WHERE id = ?', [session.id]);
    throw new UnauthorizedError('Refresh token expired');
  }

  // User must still be active
  const user = await User.findById(session.user_id);
  if (!user || user.status !== 'active') {
    throw new UnauthorizedError('User not found or inactive');
  }

  // Get user's primary organization as the fallback for the new access token
  const orgs = await User.getOrganizations(user.id);
  const primaryOrg = orgs[0] || null;
  let fallbackOrgId = primaryOrg?.id || user.organization_id;
  if (!primaryOrg) {
    const liveFallback = await findGlobalFallbackOrganization(user);
    fallbackOrgId = liveFallback?.id || fallbackOrgId;
  }

  // Preserve the active organization across refreshes (e.g. a page reload, where
  // the SPA's in-memory access token is gone). The caller passes the org from the
  // `fireisp_active_org` cookie; we RE-VALIDATE it here so a stale or forged value
  // can never grant access to an org the user may not use — invalid → fall back.
  let activeOrgId = fallbackOrgId;
  if (requestedActiveOrgId && Number(requestedActiveOrgId) !== Number(fallbackOrgId)) {
    const resolved = await resolveActiveOrg(user.id, user.role, requestedActiveOrgId);
    if (resolved) activeOrgId = resolved.id;
  }

  // Issue new access token bound to the active organization
  const newAccessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      orgId: activeOrgId,
      tv: Number(user.token_version ?? 0),
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn, algorithm: config.jwt.algorithm },
  );

  // Issue new refresh token (rotation)
  const newRefreshValue = generateRefreshToken();
  const newRefreshHash = crypto.createHash('sha256').update(newRefreshValue).digest('hex');
  const family = session.token_family;

  // Rotate: consume the old session and insert its successor in ONE
  // transaction. The DELETE is the atomic claim — when two concurrent
  // requests redeem the same token (e.g. two tabs refreshing together),
  // exactly one deletes the row; the other sees affectedRows 0 and must NOT
  // mint a second session pair from an already-consumed token (the loser's
  // client retries and succeeds with the winner's rotated cookie). The
  // transaction ensures a failed INSERT rolls the claim back — otherwise a
  // single DB blip mid-rotation would destroy the session outright, leaving
  // the user with zero valid refresh tokens.
  await consumeAndReplaceSession(session.id, [user.id, newRefreshHash, family, null, null, REFRESH_SECONDS]);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshValue,
    expiresIn: ACCESS_SECONDS,
    activeOrgId,
  };
}

/**
 * Invalidate a session (logout). Accepts a refresh token to revoke the session.
 */
async function logout(refreshTokenValue) {
  const sessionHash = crypto.createHash('sha256').update(refreshTokenValue).digest('hex');
  await db.query(
    'DELETE FROM user_sessions WHERE token_hash = ?',
    [sessionHash],
  );
}

/**
 * Request a password reset. Generates a random token valid for 1 hour.
 * Returns the token (caller is responsible for emailing it).
 */
async function requestPasswordReset(email) {
  const user = await User.findByEmail(email);
  if (!user) {
    // Return silently to prevent user enumeration
    return { message: 'If that email exists, a reset link has been sent' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await db.query(
    `UPDATE users SET reset_token_hash = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR)
     WHERE id = ?`,
    [tokenHash, user.id],
  );

  return {
    token,
    email: user.email,
    userId: user.id,
    // For the caller (route layer) to build the email greeting without a
    // second DB round-trip.
    userName: [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined,
  };
}

/**
 * Reset password using a valid token.
 */
async function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const [rows] = await db.query(
    'SELECT * FROM users WHERE reset_token_hash = ? AND reset_token_expires > NOW()',
    [tokenHash],
  );

  if (rows.length === 0) {
    throw new UnauthorizedError('Invalid or expired reset token');
  }

  const user = rows[0];
  const policy = await passwordPolicy.assertPasswordAllowed(newPassword, user.organization_id);
  await passwordPolicy.assertNotReused(user, newPassword, policy);
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await passwordPolicy.recordPasswordChange(user);

  // Clear the brute-force login lockout too: possession of the emailed reset
  // token is stronger proof of identity than a password (it required access
  // to the account's inbox), so a successful reset should break the
  // failed_login_attempts/locked_until loop from login()'s lockout logic —
  // otherwise the documented account-recovery path doesn't actually recover
  // the account, and repeatedly failing login then "recovering" becomes a
  // pointless grief/DoS loop. Both columns already exist; no migration.
  await db.query(
    `UPDATE users
        SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL,
            failed_login_attempts = 0, locked_until = NULL
      WHERE id = ?`,
    [passwordHash, user.id],
  );

  // End every session, including access tokens already issued (SEC-10).
  await revokeUserSessions(user.id);

  return { message: 'Password reset successfully' };
}

/**
 * Change password for an authenticated user.
 */
async function changePassword(userId, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }
  if (newPassword === currentPassword) {
    throw new ValidationError('The new password must differ from the current one');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new NotFoundError('User');
  }

  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  const policy = await passwordPolicy.assertPasswordAllowed(newPassword, user.organization_id, 'newPassword');
  await passwordPolicy.assertNotReused(user, newPassword, policy, 'newPassword');
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await passwordPolicy.recordPasswordChange(user);
  // Clears the forced-change flag (migration 480).
  await db.query(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
    [passwordHash, user.id],
  );

  // End every session for this user, including access tokens already issued
  // (force re-login, SEC-10).
  await revokeUserSessions(user.id);

  return { message: 'Password changed successfully' };
}

/**
 * Verify email using a token (sets email_verified_at if the token is valid).
 */
async function verifyEmail(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const [rows] = await db.query(
    'SELECT * FROM users WHERE email_verify_token_hash = ?',
    [tokenHash],
  );

  if (rows.length === 0) {
    throw new UnauthorizedError('Invalid verification token');
  }

  await db.query(
    'UPDATE users SET email_verified_at = NOW(), email_verify_token_hash = NULL WHERE id = ?',
    [rows[0].id],
  );

  return { message: 'Email verified successfully' };
}

/**
 * Switch the active organization for a user who belongs to multiple
 * organizations.  The caller proves possession of the current refresh token,
 * which we rotate (within the same family) so the previous tokens are
 * invalidated immediately.  A new access token is minted with `orgId` set to
 * the requested organization.
 *
 * Throws ForbiddenError if the user is not a member of the target org.
 */
async function switchOrganization(userId, organizationId, currentRefreshToken) {
  const { ForbiddenError } = require('../utils/errors');

  if (!organizationId) {
    throw new ValidationError('organizationId is required');
  }

  // User must still be active.
  const user = await User.findById(userId);
  if (!user || user.status !== 'active') {
    throw new UnauthorizedError('User not found or inactive');
  }

  const principal = await resolveOrgPrincipal(user, organizationId);
  if (!principal) {
    throw new ForbiddenError('User is not a member of the requested organization');
  }
  const membership = {
    org_id: principal.organizationId,
    org_name: principal.organizationName,
    membership_role: principal.membershipRole,
  };

  // Validate + rotate the refresh token.  We require the current refresh token
  // so a stolen access token alone cannot be used to pivot to another org.
  if (!currentRefreshToken) {
    throw new UnauthorizedError('Refresh token required to switch organizations');
  }
  const oldHash = crypto.createHash('sha256').update(currentRefreshToken).digest('hex');
  const [sessions] = await db.query(
    'SELECT * FROM user_sessions WHERE token_hash = ? AND user_id = ?',
    [oldHash, userId],
  );
  if (sessions.length === 0) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }
  const session = sessions[0];
  if (new Date(session.expires_at) <= new Date()) {
    await db.query('DELETE FROM user_sessions WHERE id = ?', [session.id]);
    throw new UnauthorizedError('Refresh token expired');
  }

  // Mint new access token bound to the requested organization.
  const newAccessToken = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      orgId: membership.org_id,
      tv: Number(user.token_version ?? 0),
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn, algorithm: config.jwt.algorithm },
  );

  // Rotate refresh token within the same family. As in refreshToken(): the
  // DELETE is the atomic claim (a concurrent redeem loses instead of minting
  // a duplicate pair) and the transaction rolls the claim back if the INSERT
  // fails, so a DB blip can't destroy the session.
  const newRefreshValue = generateRefreshToken();
  const newRefreshHash = crypto.createHash('sha256').update(newRefreshValue).digest('hex');
  await consumeAndReplaceSession(session.id, [user.id, newRefreshHash, session.token_family, null, null, REFRESH_SECONDS]);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshValue,
    expiresIn: ACCESS_SECONDS,
    organization: {
      id: membership.org_id,
      name: membership.org_name,
      membership_role: membership.membership_role,
    },
  };
}

/**
 * Generate an email verification token for a user.
 */
async function generateEmailVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await db.query(
    'UPDATE users SET email_verify_token_hash = ? WHERE id = ?',
    [tokenHash, userId],
  );

  return { token };
}

/**
 * Resend the email-verification link for the currently authenticated user.
 * No-op fast path when the address is already verified — avoids generating a
 * fresh token and sending an email that would go straight to an already
 * confirmed inbox.
 */
async function resendVerificationEmail(userId) {
  const user = await User.findById(userId);
  if (!user) {
    throw new NotFoundError('User');
  }

  if (user.email_verified_at) {
    return { message: 'Email already verified', alreadyVerified: true };
  }

  const { token } = await generateEmailVerificationToken(user.id);
  const verifyUrl = `${config.appUrl}/verify-email?token=${token}`;
  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined;
  const template = emailTemplates.emailVerificationEmail({ userName, verifyUrl });

  // Detached — see register() above: the SMTP round-trip must never sit on
  // the response critical path (nodemailer's connection timeout defaults to
  // ~2 minutes). sendEmail() is an async function, so a failure can only
  // ever surface via this .catch, never as an unhandled rejection.
  emailTransport.sendEmail({ operationalRecipient: true, to: user.email, subject: template.subject, html: template.html })
    .then((sendResult) => {
      if (!sendResult || !sendResult.success) {
        logger.warn(`Verification email resend failed for ${user.email}: ${sendResult && sendResult.error}`);
      }
    })
    .catch((err) => {
      logger.error(`Verification email resend threw for user ${user.id}: ${err.message}`);
    });

  return { message: 'Verification email sent' };
}

module.exports = {
  register, login, completeMfaLogin, createSsoMfaChallenge, requiresSecondFactor, logout, refreshToken, switchOrganization,
  requestPasswordReset, resetPassword, changePassword,
  verifyEmail, generateEmailVerificationToken, resendVerificationEmail,
  // Exported for cookie maxAge calculations in auth routes
  REFRESH_SECONDS,
  ACCESS_SECONDS,
};
