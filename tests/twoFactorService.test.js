// =============================================================================
// VigaBSS 5.0 — Two-Factor Authentication Service Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const twoFactorService = require('../src/services/twoFactorService');

describe('twoFactorService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks() keeps queued mockResolvedValueOnce results; reset them so
    // one failing case cannot cascade stale rows into the next.
    db.query.mockReset();
  });

  describe('hexToBase32()', () => {
    test('converts hex to base32 correctly', () => {
      // Known test vector: hex "48656c6c6f" = "JBSWY3DP"
      const result = twoFactorService.hexToBase32('48656c6c6f');
      expect(result).toBe('JBSWY3DP');
    });

    test('handles empty input', () => {
      expect(twoFactorService.hexToBase32('')).toBe('');
    });
  });

  describe('generateTOTP()', () => {
    test('generates a 6-digit code', () => {
      const secret = 'a'.repeat(40);
      const code = twoFactorService.generateTOTP(secret, 1);
      expect(code).toMatch(/^\d{6}$/);
    });

    test('same secret and time step produce same code', () => {
      const secret = 'b'.repeat(40);
      const code1 = twoFactorService.generateTOTP(secret, 100);
      const code2 = twoFactorService.generateTOTP(secret, 100);
      expect(code1).toBe(code2);
    });

    test('different time steps produce different codes', () => {
      const secret = 'c'.repeat(40);
      const code1 = twoFactorService.generateTOTP(secret, 100);
      const code2 = twoFactorService.generateTOTP(secret, 200);
      expect(code1).not.toBe(code2);
    });
  });

  describe('verifyTOTP()', () => {
    test('verifies current time step code', () => {
      const secret = 'd'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);
      expect(twoFactorService.verifyTOTP(secret, code)).toBe(true);
    });

    test('rejects invalid code', () => {
      const secret = 'e'.repeat(40);
      expect(twoFactorService.verifyTOTP(secret, '000000')).toBe(false);
    });

    test('accepts code from adjacent time window (clock drift)', () => {
      const secret = 'f'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep - 1);
      expect(twoFactorService.verifyTOTP(secret, code)).toBe(true);
    });
  });

  describe('generateSecret()', () => {
    test('returns secret and provisioning URI', async () => {
      db.query
        .mockResolvedValueOnce([[{ email: 'user@example.com' }]])  // SELECT email
        .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE totp_secret

      const result = await twoFactorService.generateSecret(1);
      expect(result.secret).toBeTruthy();
      expect(result.uri).toContain('otpauth://totp/');
      expect(result.uri).toContain('user%40example.com');
      expect(result.qr_data).toBe(result.uri);
    });

    test('throws for non-existent user', async () => {
      db.query.mockResolvedValueOnce([[]]);
      await expect(twoFactorService.generateSecret(999)).rejects.toThrow('User not found');
    });

    // SEC-03 regression: POST /2fa/setup silently disabled an enabled 2FA for
    // any session. Replacing an enabled secret now needs re-verification.
    test('refuses to replace an enabled 2FA secret without a code or password', async () => {
      db.query.mockResolvedValueOnce([[{ email: 'u@example.com', totp_enabled: 1, password_hash: 'h' }]]);
      await expect(twoFactorService.generateSecret(1)).rejects.toMatchObject({ statusCode: 403 });
      // Nothing was written.
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('refuses to replace an enabled 2FA secret with a wrong password', async () => {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('right-password', 4);
      db.query.mockResolvedValueOnce([[{ email: 'u@example.com', totp_enabled: 1, password_hash: hash }]]);
      await expect(twoFactorService.generateSecret(1, { password: 'wrong-password' }))
        .rejects.toMatchObject({ statusCode: 403 });
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('replaces an enabled 2FA secret after the password is re-verified', async () => {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('right-password', 4);
      db.query
        .mockResolvedValueOnce([[{ email: 'u@example.com', totp_enabled: 1, password_hash: hash }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      const result = await twoFactorService.generateSecret(1, { password: 'right-password' });
      expect(result.uri).toContain('otpauth://totp/');
      expect(db.query).toHaveBeenLastCalledWith(
        expect.stringContaining('totp_enabled = FALSE'),
        [expect.any(String), 1],
      );
    });

    test('replaces an enabled 2FA secret after a current TOTP code', async () => {
      const secret = 'a'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);
      db.query
        .mockResolvedValueOnce([[{ email: 'u@example.com', totp_enabled: 1, password_hash: 'h' }]])
        .mockResolvedValueOnce([[{
          totp_secret: secret, totp_enabled: 1, totp_backup_codes: null, totp_last_used_step: null,
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // claim step
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // store new secret
      const result = await twoFactorService.generateSecret(1, { code });
      expect(result.secret).toBeTruthy();
    });
  });

  describe('verifyAndEnable()', () => {
    test('enables 2FA with valid code', async () => {
      const secret = 'a'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);

      db.query
        .mockResolvedValueOnce([[{ totp_secret: secret }]])  // SELECT totp_secret
        .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE totp_enabled

      const result = await twoFactorService.verifyAndEnable(1, code);
      expect(result.enabled).toBe(true);
      expect(result.backup_codes).toHaveLength(10);
      expect(result.backup_codes[0]).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
    });

    test('throws with invalid code', async () => {
      db.query.mockResolvedValueOnce([[{ totp_secret: 'a'.repeat(40) }]]);
      await expect(twoFactorService.verifyAndEnable(1, '000000')).rejects.toThrow('Invalid verification code');
    });

    test('throws when no secret configured', async () => {
      db.query.mockResolvedValueOnce([[{ totp_secret: null }]]);
      await expect(twoFactorService.verifyAndEnable(1, '123456')).rejects.toThrow('No 2FA secret configured');
    });
  });

  describe('verifyCode()', () => {
    test('verifies TOTP code during login', async () => {
      const secret = 'a'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);

      db.query
        .mockResolvedValueOnce([[{
          totp_secret: secret,
          totp_enabled: true,
          totp_backup_codes: '[]',
          totp_last_used_step: null,
        }]])
        // The accepted step is claimed with a conditional UPDATE (migration
        // 467 replay guard) — a new statement, hence the extra mock.
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await twoFactorService.verifyCode(1, code);
      expect(result.valid).toBe(true);
      expect(result.method).toBe('totp');
      expect(db.query).toHaveBeenLastCalledWith(
        expect.stringContaining('totp_last_used_step IS NULL OR totp_last_used_step < ?'),
        [currentStep, 1, currentStep],
      );
    });

    // SEC-03 regression: a TOTP code was accepted any number of times inside
    // its drift window.
    test('rejects a replayed TOTP code (step already used) without claiming it again', async () => {
      const secret = 'a'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);

      db.query.mockResolvedValueOnce([[{
        totp_secret: secret,
        totp_enabled: true,
        totp_backup_codes: '[]',
        totp_last_used_step: currentStep,
      }]]);

      await expect(twoFactorService.verifyCode(1, code)).rejects.toMatchObject({ statusCode: 401 });
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('rejects a TOTP code when a concurrent request already claimed its step', async () => {
      const secret = 'a'.repeat(40);
      const currentStep = Math.floor(Date.now() / 1000 / 30);
      const code = twoFactorService.generateTOTP(secret, currentStep);

      db.query
        .mockResolvedValueOnce([[{
          totp_secret: secret, totp_enabled: true, totp_backup_codes: '[]', totp_last_used_step: null,
        }]])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);

      await expect(twoFactorService.verifyCode(1, code)).rejects.toMatchObject({ statusCode: 401 });
    });

    // SEC-03 regression: mysql2 decodes the JSON column to an array, and
    // JSON.parse(array) threw — every backup-code login returned 500.
    test('accepts a backup code when the JSON column arrives already decoded', async () => {
      const crypto = require('crypto');
      const hashed = crypto.createHash('sha256').update('ABCD-EF12').digest('hex');

      db.query
        .mockResolvedValueOnce([[{
          totp_secret: 'a'.repeat(40),
          totp_enabled: true,
          totp_backup_codes: [hashed, 'otherhash'],
          totp_last_used_step: null,
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await twoFactorService.verifyCode(1, 'abcd ef12');
      expect(result).toMatchObject({ valid: true, method: 'backup_code', remaining_codes: 1 });
      // Consumed with one atomic JSON_REMOVE guarded by the code still existing.
      const [sql, params] = db.query.mock.calls[1];
      expect(sql).toContain('JSON_REMOVE');
      expect(sql).toContain('JSON_SEARCH(totp_backup_codes, \'one\', ?) IS NOT NULL');
      expect(params).toEqual([hashed, 1, hashed]);
    });

    test('returns 401 (not 500) for a wrong code when backup codes are malformed', async () => {
      db.query.mockResolvedValueOnce([[{
        totp_secret: 'a'.repeat(40),
        totp_enabled: true,
        totp_backup_codes: { not: 'an array' },
        totp_last_used_step: null,
      }]]);

      await expect(twoFactorService.verifyCode(1, 'ABCD-EF12')).rejects.toMatchObject({ statusCode: 401 });
    });

    test('a backup code redeemed concurrently is accepted only once', async () => {
      const crypto = require('crypto');
      const hashed = crypto.createHash('sha256').update('ABCD-EF12').digest('hex');
      db.query
        .mockResolvedValueOnce([[{
          totp_secret: 'a'.repeat(40), totp_enabled: true, totp_backup_codes: [hashed], totp_last_used_step: null,
        }]])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);

      await expect(twoFactorService.verifyCode(1, 'ABCD-EF12')).rejects.toMatchObject({ statusCode: 401 });
    });

    test('verifies backup code and removes it', async () => {
      const crypto = require('crypto');
      const backupCode = 'ABCD-EF12';
      const hashed = crypto.createHash('sha256').update(backupCode).digest('hex');

      db.query
        .mockResolvedValueOnce([[{
          totp_secret: 'a'.repeat(40),
          totp_enabled: true,
          totp_backup_codes: JSON.stringify([hashed, 'otherhash']),
        }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE backup codes

      const result = await twoFactorService.verifyCode(1, backupCode);
      expect(result.valid).toBe(true);
      expect(result.method).toBe('backup_code');
      expect(result.remaining_codes).toBe(1);
    });

    test('throws for invalid code', async () => {
      db.query.mockResolvedValueOnce([[{
        totp_secret: 'a'.repeat(40),
        totp_enabled: true,
        totp_backup_codes: '[]',
      }]]);

      await expect(twoFactorService.verifyCode(1, 'invalid')).rejects.toThrow('Invalid 2FA code');
    });

    test('throws when 2FA not enabled', async () => {
      db.query.mockResolvedValueOnce([[{
        totp_secret: 'a'.repeat(40),
        totp_enabled: false,
        totp_backup_codes: null,
      }]]);

      await expect(twoFactorService.verifyCode(1, '123456')).rejects.toThrow('2FA is not enabled');
    });
  });

  describe('disable()', () => {
    test('clears TOTP data', async () => {
      db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
      const result = await twoFactorService.disable(1);
      expect(result.enabled).toBe(false);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('totp_enabled = FALSE'),
        [1],
      );
    });
  });

  describe('getStatus()', () => {
    test('returns enabled status', async () => {
      db.query.mockResolvedValueOnce([[{ totp_enabled: true }]]);
      const result = await twoFactorService.getStatus(1);
      expect(result.enabled).toBe(true);
    });

    test('returns disabled when no user', async () => {
      db.query.mockResolvedValueOnce([[]]);
      const result = await twoFactorService.getStatus(999);
      expect(result.enabled).toBe(false);
    });
  });
});
