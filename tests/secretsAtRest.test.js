// =============================================================================
// SEC-28 — TOTP secrets, backup codes and boot checks
// =============================================================================
// TOTP secrets were stored as plaintext hex, so a database copy could generate
// every user's codes. Backup codes had 32 bits and were stored as unsalted
// SHA-256, reversible offline by trying all 2^32 values. ENCRYPTION_KEY was
// fatal only in production, and production accepted an http APP_URL.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const crypto = require('crypto');
const db = require('../src/config/database');
const twoFactorService = require('../src/services/twoFactorService');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENCRYPTION_KEY = KEY_A;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe('TOTP secret at rest', () => {
  test('setup stores the secret encrypted, and enabling decrypts it to check the code', async () => {
    db.query
      .mockResolvedValueOnce([[{ email: 'u@example.com', totp_enabled: 0, password_hash: 'h' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const { secret: base32 } = await twoFactorService.generateSecret(1);
    const stored = db.query.mock.calls[1][1][0];

    expect(stored).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(stored).not.toMatch(/^[0-9a-f]{40}$/);
    const plainHex = require('../src/utils/encryption').decryptStrict(stored);
    expect(twoFactorService.hexToBase32(plainHex)).toBe(base32);

    const code = twoFactorService.generateTOTP(plainHex);
    db.query
      .mockResolvedValueOnce([[{ totp_secret: stored }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(twoFactorService.verifyAndEnable(1, code)).resolves.toMatchObject({ enabled: true });
  });

  test('a secret that does not decrypt with the key is refused, not used', async () => {
    db.query.mockResolvedValueOnce([[{
      totp_secret: `${'0'.repeat(24)}:${'0'.repeat(32)}:abcd`, totp_enabled: true,
      totp_backup_codes: '[]', totp_last_used_step: null,
    }]]);

    await expect(twoFactorService.verifyCode(1, '123456')).rejects.toMatchObject({ code: 'ENCRYPTED_SECRET_INVALID' });
  });
});

describe('backup codes', () => {
  test('codes carry 64 bits and the old 32-bit form is no longer accepted', () => {
    expect(twoFactorService.normalizeBackupCode('abcd ef12 3456 7890')).toBe('ABCD-EF12-3456-7890');
    expect(twoFactorService.normalizeBackupCode('ABCD-EF12')).toBeNull();
  });

  test('stored hashes are keyed by ENCRYPTION_KEY, not plain SHA-256', () => {
    const code = 'ABCD-EF12-3456-7890';
    const withA = twoFactorService.hashBackupCode(code);
    expect(withA).not.toBe(crypto.createHash('sha256').update(code).digest('hex'));
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(twoFactorService.hashBackupCode(code)).not.toBe(withA);
  });
});

describe('boot checks', () => {
  const VALID_SECRET = 'x'.repeat(64);
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; jest.resetModules(); });

  function validate(env) {
    Object.assign(process.env, {
      JWT_SECRET: VALID_SECRET, DB_HOST: 'localhost', DB_NAME: 'fireisp', ...env,
    });
    jest.resetModules();
    return () => require('../src/config').validateEnv(null);
  }

  test('a staging install without ENCRYPTION_KEY does not start', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(validate({ NODE_ENV: 'staging' })).toThrow(/ENCRYPTION_KEY is not set/);
  });

  test('production refuses an http APP_URL and accepts https', () => {
    expect(validate({ NODE_ENV: 'production', ENCRYPTION_KEY: KEY_A, APP_URL: 'http://isp.example.com' }))
      .toThrow(/APP_URL must be an https:\/\/ URL/);
    expect(validate({ NODE_ENV: 'production', ENCRYPTION_KEY: KEY_A, APP_URL: 'https://isp.example.com' }))
      .not.toThrow();
  });

  test('development still runs without a key, with a warning', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(validate({ NODE_ENV: 'development' })).not.toThrow();
  });
});
