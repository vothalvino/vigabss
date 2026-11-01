// =============================================================================
// VigaBSS 5.0 — Per-organization password policy (SEC-17)
// =============================================================================
// PUT /security-admin/password-policy stores a password_policies row; this
// service is what makes it bite. A user is governed by the policy of their
// home organization (users.organization_id). With no active row, the built-in
// defaults below apply: they are the rules that were hard-coded before.
//
// Enforced:
//   - composition (min_length, upper/lower/digit/special, max_repeated_chars)
//     when a password is set: register, change, reset, admin create/update
//   - lockout_attempts / lockout_duration_minutes on failed sign-in
//   - history_count on self-service change and reset (password_history)
//   - rotation_days at password sign-in: an expired password sets
//     must_change_password, which auth.js already enforces (migration 480)
// =============================================================================

const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { ValidationError } = require('../utils/errors');

const DEFAULT_POLICY = Object.freeze({
  min_length: 8,
  require_uppercase: 0,
  require_lowercase: 0,
  require_digits: 0,
  require_special_chars: 0,
  max_repeated_chars: null,
  rotation_days: null,
  history_count: 0,
  lockout_attempts: 5,
  lockout_duration_minutes: 15,
});

// Hashes kept per user regardless of policy, so raising history_count later
// still has something to compare against. Also bounds the bcrypt work.
const HISTORY_RETAINED = 24;

/** The active policy for an organization, or the defaults. */
async function loadPolicy(organizationId) {
  const orgId = Number(organizationId);
  if (!Number.isInteger(orgId) || orgId < 1) return { ...DEFAULT_POLICY };
  const [rows] = await db.query(
    'SELECT * FROM password_policies WHERE organization_id = ? AND is_active = 1 LIMIT 1',
    [orgId],
  );
  const row = rows && rows[0];
  if (!row) return { ...DEFAULT_POLICY };
  const policy = { ...DEFAULT_POLICY };
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (row[key] !== undefined) policy[key] = row[key];
  }
  return policy;
}

function longestRun(text) {
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const ch of text) {
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > longest) longest = run;
  }
  return longest;
}

/** Throw a ValidationError listing every rule the password breaks. */
function assertPasswordMeetsPolicy(password, policy, field = 'password') {
  const text = typeof password === 'string' ? password : '';
  const minLength = Math.max(8, Number(policy.min_length) || 8);
  const tooShort = text.length < minLength;
  const failures = [];
  if (Number(policy.require_uppercase) === 1 && !/[A-Z]/.test(text)) failures.push('an uppercase letter');
  if (Number(policy.require_lowercase) === 1 && !/[a-z]/.test(text)) failures.push('a lowercase letter');
  if (Number(policy.require_digits) === 1 && !/[0-9]/.test(text)) failures.push('a digit');
  if (Number(policy.require_special_chars) === 1 && !/[^A-Za-z0-9]/.test(text)) failures.push('a symbol');
  const maxRepeated = Number(policy.max_repeated_chars);
  const repeatRule = Number.isInteger(maxRepeated) && maxRepeated > 0 && longestRun(text) > maxRepeated;

  if (!tooShort && failures.length === 0 && !repeatRule) return;
  const parts = [];
  if (tooShort) parts.push(`be at least ${minLength} characters`);
  if (failures.length) parts.push(`contain ${failures.join(', ')}`);
  if (repeatRule) parts.push(`not repeat a character more than ${maxRepeated} times in a row`);
  const message = `Password must ${parts.join(' and ')}`;
  throw new ValidationError(message, [{ field, message }]);
}

/** Load the organization policy and check a new password against it. */
async function assertPasswordAllowed(password, organizationId, field = 'password') {
  const policy = await loadPolicy(organizationId);
  assertPasswordMeetsPolicy(password, policy, field);
  return policy;
}

/**
 * Refuse a password equal to the current one or to any of the last
 * history_count recorded passwords.
 */
async function assertNotReused(user, password, policy, field = 'password') {
  const count = Math.min(Number(policy.history_count) || 0, HISTORY_RETAINED);
  if (count < 1) return;
  const [rows] = await db.query(
    'SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [user.id, count],
  );
  const hashes = [user.password_hash, ...rows.map(r => r.password_hash)].filter(Boolean);
  for (const hash of hashes) {
    if (await bcrypt.compare(password, hash)) {
      const message = `Password must differ from your last ${count} passwords`;
      throw new ValidationError(message, [{ field, message }]);
    }
  }
}

/**
 * Remember the hash being replaced and stamp the change. Call in the same
 * flow that writes the new password_hash.
 */
async function recordPasswordChange(user) {
  if (user.password_hash) {
    await db.query('INSERT INTO password_history (user_id, password_hash) VALUES (?, ?)', [user.id, user.password_hash]);
    await db.query(
      `DELETE FROM password_history
        WHERE user_id = ?
          AND id NOT IN (SELECT id FROM (
            SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?
          ) AS keep)`,
      [user.id, user.id, HISTORY_RETAINED],
    );
  }
  await db.query('UPDATE users SET password_changed_at = NOW() WHERE id = ?', [user.id]);
}

/** True when rotation_days is set and the password is older than that. */
function passwordExpired(user, policy, now = Date.now()) {
  const days = Number(policy.rotation_days);
  if (!Number.isInteger(days) || days < 1) return false;
  const changed = user.password_changed_at ? new Date(user.password_changed_at).getTime() : NaN;
  if (!Number.isFinite(changed)) return false;
  return now - changed > days * 24 * 60 * 60 * 1000;
}

module.exports = {
  DEFAULT_POLICY,
  HISTORY_RETAINED,
  loadPolicy,
  assertPasswordMeetsPolicy,
  assertPasswordAllowed,
  assertNotReused,
  recordPasswordChange,
  passwordExpired,
};
