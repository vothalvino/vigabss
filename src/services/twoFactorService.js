// =============================================================================
// VigaBSS 5.0 — Two-Factor Authentication (2FA/MFA) Service
// =============================================================================
// TOTP-based two-factor authentication using RFC 6238.
// Supports Google Authenticator, Authy, and similar TOTP apps.
// Includes backup codes for account recovery.
// =============================================================================

const crypto = require('crypto');
const db = require('../config/database');
const { UnauthorizedError, ValidationError, ForbiddenError } = require('../utils/errors');

// TOTP parameters
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_ALGORITHM = 'sha1';
const BACKUP_CODE_COUNT = 10;
const TOTP_WINDOW = 1; // Allow ±1 time step for clock drift

/**
 * Generate a TOTP secret for a user. Does NOT enable 2FA yet.
 * Returns the secret and a provisioning URI for QR code generation.
 *
 * Replacing the secret of an account that already has 2FA enabled turns 2FA
 * off until the new secret is verified, so it requires re-verification: a
 * current TOTP/backup code or the account password. Without it, any session
 * (stolen cookie, unattended browser) could silently strip the second factor.
 *
 * @param {number} userId
 * @param {{ code?: string, password?: string }} [reauth]
 */
async function generateSecret(userId, reauth = {}) {
  const [users] = await db.query(
    'SELECT email, totp_enabled, password_hash FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId],
  );
  if (users.length === 0) throw new ValidationError('User not found');

  if (users[0].totp_enabled) {
    const code = typeof reauth.code === 'string' && reauth.code !== '' ? reauth.code : null;
    const password = typeof reauth.password === 'string' && reauth.password !== '' ? reauth.password : null;
    if (code) {
      await verifyCode(userId, code);
    } else if (password) {
      const bcrypt = require('bcryptjs');
      if (!await bcrypt.compare(password, users[0].password_hash || '')) {
        throw new ForbiddenError('Invalid password');
      }
    } else {
      throw new ForbiddenError(
        'Two-factor authentication is already enabled. Provide a current code or your password to replace it.',
      );
    }
  }

  const secret = crypto.randomBytes(20).toString('hex');
  const base32Secret = hexToBase32(secret);

  // Store the secret (not yet verified/enabled). A fresh secret starts a fresh
  // replay window.
  await db.query(
    'UPDATE users SET totp_secret = ?, totp_enabled = FALSE, totp_last_used_step = NULL WHERE id = ?',
    [secret, userId],
  );

  const issuer = 'VigaBSS';
  const account = users[0].email;
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32Secret}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;

  return {
    secret: base32Secret,
    uri,
    qr_data: uri,
  };
}

/**
 * Verify a TOTP code and enable 2FA for the user.
 * Must be called after generateSecret() to confirm the user has set up their authenticator.
 */
async function verifyAndEnable(userId, code) {
  const [users] = await db.query(
    'SELECT totp_secret FROM users WHERE id = ?',
    [userId],
  );
  if (users.length === 0 || !users[0].totp_secret) {
    throw new ValidationError('No 2FA secret configured. Call setup first.');
  }

  const step = typeof code === 'string' ? matchTOTPStep(users[0].totp_secret, code.trim()) : null;
  if (step === null) {
    throw new UnauthorizedError('Invalid verification code');
  }

  // Generate backup codes
  const backupCodes = generateBackupCodes();
  const hashedCodes = backupCodes.map(c =>
    crypto.createHash('sha256').update(c).digest('hex'),
  );

  await db.query(
    // Record the enrolment step so the same code cannot be replayed at login.
    'UPDATE users SET totp_enabled = TRUE, totp_backup_codes = ?, totp_last_used_step = ? WHERE id = ?',
    [JSON.stringify(hashedCodes), step, userId],
  );

  return {
    enabled: true,
    backup_codes: backupCodes,
    message: 'Two-factor authentication enabled. Save your backup codes securely.',
  };
}

/**
 * Parse the stored backup-code hashes. mysql2 returns a JSON column already
 * decoded (an array), while older drivers/tests hand back the JSON text; any
 * other shape is treated as "no codes" instead of throwing (which used to turn
 * every backup-code attempt into a 500).
 */
function parseBackupCodes(raw) {
  if (Array.isArray(raw)) return raw.filter(c => typeof c === 'string');
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(c => typeof c === 'string') : [];
    } catch (_err) {
      return [];
    }
  }
  if (Buffer.isBuffer(raw)) return parseBackupCodes(raw.toString('utf8'));
  return [];
}

/** Canonical form of a typed backup code: trimmed, upper-case, XXXX-XXXX. */
function normalizeBackupCode(code) {
  const compact = String(code).trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[0-9A-F]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Verify a TOTP or backup code for a user with 2FA enabled.
 *
 * Each TOTP time step is accepted at most once (users.totp_last_used_step is
 * advanced with a conditional UPDATE, so two concurrent requests replaying the
 * same code cannot both succeed), and each backup code is consumed by a single
 * atomic JSON_REMOVE. Wrong codes throw UnauthorizedError (401).
 */
async function verifyCode(userId, code) {
  const [users] = await db.query(
    'SELECT totp_secret, totp_enabled, totp_backup_codes, totp_last_used_step FROM users WHERE id = ?',
    [userId],
  );
  if (users.length === 0) throw new UnauthorizedError('User not found');

  const user = users[0];
  if (!user.totp_enabled) {
    throw new ValidationError('2FA is not enabled for this account');
  }
  if (typeof code !== 'string' || code.trim() === '') {
    throw new UnauthorizedError('Invalid 2FA code');
  }
  const trimmed = code.trim();

  // Try TOTP first
  const step = user.totp_secret ? matchTOTPStep(user.totp_secret, trimmed) : null;
  if (step !== null) {
    const lastStep = user.totp_last_used_step === null || user.totp_last_used_step === undefined
      ? null
      : Number(user.totp_last_used_step);
    if (lastStep === null || step > lastStep) {
      const [claim] = await db.query(
        `UPDATE users SET totp_last_used_step = ?
          WHERE id = ? AND totp_enabled = TRUE
            AND (totp_last_used_step IS NULL OR totp_last_used_step < ?)`,
        [step, userId, step],
      );
      if (claim && claim.affectedRows === 1) {
        return { valid: true, method: 'totp' };
      }
    }
    throw new UnauthorizedError('This 2FA code has already been used');
  }

  // Try backup code
  const normalized = normalizeBackupCode(trimmed);
  if (normalized) {
    const backupCodes = parseBackupCodes(user.totp_backup_codes);
    const codeHash = hashBackupCode(normalized);
    if (backupCodes.includes(codeHash)) {
      // One statement removes exactly this hash, so concurrent redemptions of
      // the same code cannot both succeed and two different codes redeemed
      // at once cannot resurrect each other.
      const [claim] = await db.query(
        `UPDATE users
            SET totp_backup_codes = JSON_REMOVE(totp_backup_codes,
                  JSON_UNQUOTE(JSON_SEARCH(totp_backup_codes, 'one', ?)))
          WHERE id = ? AND totp_enabled = TRUE
            AND JSON_SEARCH(totp_backup_codes, 'one', ?) IS NOT NULL`,
        [codeHash, userId, codeHash],
      );
      if (claim && claim.affectedRows === 1) {
        return { valid: true, method: 'backup_code', remaining_codes: backupCodes.length - 1 };
      }
    }
  }

  throw new UnauthorizedError('Invalid 2FA code');
}

/**
 * Disable 2FA for a user.
 */
async function disable(userId) {
  await db.query(
    'UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_backup_codes = NULL, totp_last_used_step = NULL WHERE id = ?',
    [userId],
  );
  return { enabled: false, message: 'Two-factor authentication disabled' };
}

/**
 * Check if a user has 2FA enabled.
 */
async function getStatus(userId) {
  const [users] = await db.query(
    'SELECT totp_enabled FROM users WHERE id = ?',
    [userId],
  );
  return {
    enabled: !!(users[0]?.totp_enabled),
  };
}

/**
 * Regenerate backup codes for a user (requires valid 2FA code).
 */
async function regenerateBackupCodes(userId, code) {
  // Verify user has 2FA enabled and code is valid
  await verifyCode(userId, code);

  const backupCodes = generateBackupCodes();
  const hashedCodes = backupCodes.map(c =>
    crypto.createHash('sha256').update(c).digest('hex'),
  );

  await db.query(
    'UPDATE users SET totp_backup_codes = ? WHERE id = ?',
    [JSON.stringify(hashedCodes), userId],
  );

  return { backup_codes: backupCodes };
}

// ---------------------------------------------------------------------------
// TOTP Implementation (RFC 6238)
// ---------------------------------------------------------------------------

/**
 * Generate a TOTP value for the current time step.
 */
function generateTOTP(hexSecret, timeStep = null) {
  const time = timeStep ?? Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(time, 4);

  const hmac = crypto.createHmac(TOTP_ALGORITHM, Buffer.from(hexSecret, 'hex'));
  hmac.update(timeBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % (10 ** TOTP_DIGITS);
  return String(otp).padStart(TOTP_DIGITS, '0');
}

/**
 * Return the matching time step for a TOTP code within the ±window drift
 * tolerance, or null when the code matches none.
 */
function matchTOTPStep(hexSecret, code) {
  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD);

  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    const expected = generateTOTP(hexSecret, currentStep + i);
    if (timingSafeEqual(code, expected)) {
      return currentStep + i;
    }
  }
  return null;
}

/**
 * Verify a TOTP code with a ±window tolerance for clock drift.
 * Stateless: it does not enforce single use (verifyCode() does).
 */
function verifyTOTP(hexSecret, code) {
  return matchTOTPStep(hexSecret, code) !== null;
}

/**
 * Generate random backup codes.
 */
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/**
 * Timing-safe string comparison.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (_err) {
    return false;
  }
}

/**
 * Convert hex to Base32 (RFC 4648) for QR code provisioning URIs.
 */
function hexToBase32(hex) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = Buffer.from(hex, 'hex');
  let bits = '';
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += alphabet[parseInt(chunk, 2)];
  }
  return result;
}

module.exports = {
  generateSecret,
  verifyAndEnable,
  verifyCode,
  disable,
  getStatus,
  regenerateBackupCodes,
  generateTOTP,
  verifyTOTP,
  matchTOTPStep,
  parseBackupCodes,
  normalizeBackupCode,
  hexToBase32,
};
