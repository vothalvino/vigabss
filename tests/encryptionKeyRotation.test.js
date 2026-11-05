// =============================================================================
// SEC-28 — ENCRYPTION_KEY can be rotated
// =============================================================================
// A ciphertext was iv:tag:ciphertext with nothing naming its key, so the key
// could never change: a new key made every stored secret unreadable, and a
// leaked key could not be retired. Each value now carries the id of the key
// that sealed it; ENCRYPTION_KEYS_PREVIOUS keeps old keys for decryption, and
// rotate-encryption-key.js re-seals every value under the current key.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const crypto = require('crypto');
const db = require('../src/config/database');
const encryption = require('../src/utils/encryption');
const twoFactorService = require('../src/services/twoFactorService');
const { rotateEncryptionKey } = require('../src/scripts/rotate-encryption-key');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const idOf = hex => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENCRYPTION_KEY = KEY_A;
  delete process.env.ENCRYPTION_KEYS_PREVIOUS;
});

afterAll(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEYS_PREVIOUS;
});

/** Rotate A → B, keeping A for decryption. */
function rotateToB() {
  process.env.ENCRYPTION_KEY = KEY_B;
  process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_A;
}

describe('sealed values name their key', () => {
  test('a ciphertext carries the id of the key that sealed it', () => {
    expect(encryption.encrypt('sk_live_1')).toMatch(new RegExp(`^vb1:${idOf(KEY_A)}:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$`));
    expect(encryption.currentKeyId()).toBe(idOf(KEY_A));
  });

  test('after rotation the previous key still opens old values and new ones use the new key', () => {
    const old = encryption.encryptStrict('sk_live_1');
    rotateToB();
    expect(encryption.decryptStrict(old)).toBe('sk_live_1');
    expect(encryption.decrypt(old)).toBe('sk_live_1');
    expect(encryption.encrypt('x').split(':')[1]).toBe(idOf(KEY_B));
  });

  test('without the old key, a value it sealed is refused, naming the missing key', () => {
    const old = encryption.encryptStrict('sk_live_1');
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(() => encryption.decryptStrict(old)).toThrow(expect.objectContaining({ code: 'ENCRYPTION_KEY_UNKNOWN' }));
    // The compatibility reader still passes it through rather than crashing.
    expect(encryption.decrypt(old)).toBe(old);
  });

  test('a tampered value is refused even when its key is configured', () => {
    const sealed = encryption.encryptStrict('sk_live_1');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('00') ? '11' : '00');
    expect(() => encryption.decryptStrict(tampered)).toThrow(expect.objectContaining({ code: 'ENCRYPTED_SECRET_INVALID' }));
  });

  test('a malformed ENCRYPTION_KEYS_PREVIOUS entry is a configuration error', () => {
    process.env.ENCRYPTION_KEYS_PREVIOUS = 'not-a-key';
    expect(() => encryption.keyRing()).toThrow(/ENCRYPTION_KEYS_PREVIOUS/);
  });

  test('resealWithCurrentKey re-seals values embedded in JSON and leaves current ones alone', () => {
    const old = encryption.encryptStrict('wifi-pass');
    rotateToB();
    const fresh = encryption.encryptStrict('loid');
    const result = encryption.resealWithCurrentKey(JSON.stringify({ a: old, b: fresh, c: 'plain' }));
    expect(result).toMatchObject({ resealed: 1, unknown: 0 });
    const parsed = JSON.parse(result.text);
    expect(parsed.b).toBe(fresh);
    expect(parsed.a.split(':')[1]).toBe(idOf(KEY_B));
    expect(encryption.decryptStrict(parsed.a)).toBe('wifi-pass');
    expect(parsed.c).toBe('plain');
  });
});

describe('backup codes survive a rotation', () => {
  test('a code issued under the previous key still verifies', async () => {
    const hashed = twoFactorService.hashBackupCode('ABCD-EF12-3456-7890');
    rotateToB();
    db.query
      .mockResolvedValueOnce([[{ totp_secret: null, totp_enabled: true, totp_backup_codes: [hashed], totp_last_used_step: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await expect(twoFactorService.verifyCode(1, 'ABCD-EF12-3456-7890')).resolves.toMatchObject({ valid: true, method: 'backup_code' });
    // The claim removes exactly the stored (old-key) hash.
    expect(db.query.mock.calls[1][1]).toEqual([hashed, 1, hashed]);
  });

  test('new codes are hashed with the current key', () => {
    const before = twoFactorService.hashBackupCode('ABCD-EF12-3456-7890');
    rotateToB();
    expect(twoFactorService.hashBackupCode('ABCD-EF12-3456-7890')).not.toBe(before);
  });
});

describe('rotate-encryption-key.js', () => {
  // A fake database: one text column and one JSON column, read and updated
  // through the same SQL the script sends to MySQL.
  function fakeDatabase(rows) {
    const updates = [];
    const query = jest.fn(async (sql, params = []) => {
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql)) {
        return [[
          { table_name: 'payment_gateways', column_name: 'secret_key_encrypted', data_type: 'varchar' },
          { table_name: 'integration_configs', column_name: 'settings', data_type: 'json' },
          { table_name: 'no_pk', column_name: 'note', data_type: 'text' },
        ]];
      }
      if (/KEY_COLUMN_USAGE/.test(sql)) {
        return [[{ table_name: 'payment_gateways', column_name: 'id' }, { table_name: 'integration_configs', column_name: 'id' }]];
      }
      const select = /^SELECT `id`, CAST\(`(\w+)` AS CHAR\) AS sealed_value\s+FROM `(\w+)`/.exec(sql.trim());
      if (select) {
        const [, column, table] = select;
        const current = params[0].slice(0, -1);
        return [rows.filter(r => r.table === table && r.column === column && r.value.includes('vb1:') && !r.value.startsWith(current))
          .map(r => ({ id: r.id, sealed_value: r.value }))];
      }
      const update = /^UPDATE `(\w+)` SET `(\w+)` = (\?|CAST\(\? AS JSON\))/.exec(sql.trim());
      if (update) {
        const [, table, column, placeholder] = update;
        const [value, id, expected] = params;
        const row = rows.find(r => r.table === table && r.column === column && r.id === id);
        updates.push({ table, column, json: placeholder !== '?' });
        if (!row || row.value !== expected) return [{ affectedRows: 0 }];
        row.value = value;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    return { db: { query }, updates };
  }

  test('a dry run reports what an old key sealed and writes nothing', async () => {
    const old = encryption.encryptStrict('sk_live_1');
    rotateToB();
    const rows = [{ table: 'payment_gateways', column: 'secret_key_encrypted', id: 1, value: old }];
    const { db: fake, updates } = fakeDatabase(rows);
    const result = await rotateEncryptionKey({ db: fake });
    expect(result).toMatchObject({ values: 1, resealed: 0, unknown: 0 });
    expect(updates).toEqual([]);
    expect(result.failed).toEqual([{ table: 'no_pk', column: 'note', reason: 'no primary key' }]);
  });

  test('--apply re-seals text and JSON columns under the current key', async () => {
    const old = encryption.encryptStrict('sk_live_1');
    const oldJson = JSON.stringify({ api_key: encryption.encryptStrict('k-1') });
    rotateToB();
    const rows = [
      { table: 'payment_gateways', column: 'secret_key_encrypted', id: 1, value: old },
      { table: 'integration_configs', column: 'settings', id: 7, value: oldJson },
    ];
    const { db: fake, updates } = fakeDatabase(rows);
    const result = await rotateEncryptionKey({ db: fake, apply: true });
    expect(result).toMatchObject({ values: 2, resealed: 2, skipped: 0, unknown: 0 });
    expect(updates).toEqual([
      { table: 'payment_gateways', column: 'secret_key_encrypted', json: false },
      { table: 'integration_configs', column: 'settings', json: true },
    ]);
    expect(rows[0].value.split(':')[1]).toBe(idOf(KEY_B));
    expect(encryption.decryptStrict(rows[0].value)).toBe('sk_live_1');
    expect(encryption.decryptStrict(JSON.parse(rows[1].value).api_key)).toBe('k-1');

    // Rerun: nothing is left under the old key, so it can be removed.
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    expect(await rotateEncryptionKey({ db: fake })).toMatchObject({ values: 0, unknown: 0 });
  });

  test('a value sealed by a key that is not configured is counted, not touched', async () => {
    const old = encryption.encryptStrict('sk_live_1');
    process.env.ENCRYPTION_KEY = KEY_B; // A was dropped too early
    const rows = [{ table: 'payment_gateways', column: 'secret_key_encrypted', id: 1, value: old }];
    const { db: fake, updates } = fakeDatabase(rows);
    expect(await rotateEncryptionKey({ db: fake, apply: true })).toMatchObject({ values: 0, unknown: 1 });
    expect(updates).toEqual([]);
    expect(rows[0].value).toBe(old);
  });

  test('a row changed since it was read is skipped, not overwritten', async () => {
    const old = encryption.encryptStrict('sk_live_1');
    rotateToB();
    const rows = [{ table: 'payment_gateways', column: 'secret_key_encrypted', id: 1, value: old }];
    const { db: fake } = fakeDatabase(rows);
    const realQuery = fake.query.getMockImplementation();
    fake.query.mockImplementation(async (sql, params) => {
      if (/^UPDATE/.test(sql.trim())) rows[0].value = encryption.encryptStrict('saved meanwhile');
      return realQuery(sql, params);
    });
    expect(await rotateEncryptionKey({ db: fake, apply: true })).toMatchObject({ values: 1, resealed: 0, skipped: 1 });
    expect(encryption.decryptStrict(rows[0].value)).toBe('saved meanwhile');
  });
});
