// =============================================================================
// ASY-30 — off-site backups can be encrypted before they leave the host
// =============================================================================
// The remote copy was only gzipped: anyone who could read the bucket could
// read the whole database. With BACKUP_ENCRYPTION_KEY set, backup() uploads an
// AES-256-GCM file instead, and decryptBackup.js restores it.
// =============================================================================

jest.mock('../src/utils/logger', () => {
  const mock = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn(() => mock),
  };
  return mock;
});

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { backupEncryptionKey, encryptFile, decryptFile } = require('../src/utils/backupEncryption');

const KEY_B64 = crypto.randomBytes(32).toString('base64');
const ENV_KEYS = ['BACKUP_DIR', 'BACKUP_MIN_BYTES', 'BACKUP_ENCRYPTION_KEY', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'PATH'];

let tmp;
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asy30-enc-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.dontMock('../src/services/cloudStorageService');
  jest.dontMock('../src/services/backupSettingsService');
  jest.dontMock('../src/models/BackupRun');
});

describe('backup encryption format', () => {
  test('encrypts and decrypts back to the same bytes', async () => {
    const key = backupEncryptionKey(KEY_B64);
    const plain = path.join(tmp, 'dump.sql.gz');
    fs.writeFileSync(plain, crypto.randomBytes(100000));

    await encryptFile(plain, `${plain}.enc`, key);
    const encrypted = fs.readFileSync(`${plain}.enc`);
    expect(encrypted.subarray(0, 4).toString()).toBe('VBK1');
    expect(encrypted.length).toBe(100000 + 4 + 12 + 16);
    expect(encrypted.includes(fs.readFileSync(plain).subarray(0, 64))).toBe(false);

    await decryptFile(`${plain}.enc`, path.join(tmp, 'restored.sql.gz'), key);
    expect(fs.readFileSync(path.join(tmp, 'restored.sql.gz')).equals(fs.readFileSync(plain))).toBe(true);
  });

  test('a tampered file or the wrong key fails and leaves no output', async () => {
    const key = backupEncryptionKey(KEY_B64);
    const plain = path.join(tmp, 'dump.sql.gz');
    fs.writeFileSync(plain, Buffer.alloc(5000, 1));
    await encryptFile(plain, `${plain}.enc`, key);

    const tampered = fs.readFileSync(`${plain}.enc`);
    tampered[100] ^= 0xff;
    fs.writeFileSync(path.join(tmp, 'tampered.enc'), tampered);
    const out = path.join(tmp, 'out.sql.gz');
    await expect(decryptFile(path.join(tmp, 'tampered.enc'), out, key)).rejects.toThrow(/decryption failed/);
    expect(fs.existsSync(out)).toBe(false);

    await expect(decryptFile(`${plain}.enc`, out, crypto.randomBytes(32))).rejects.toThrow(/decryption failed/);
    expect(fs.existsSync(out)).toBe(false);

    await expect(decryptFile(plain, out, key)).rejects.toThrow(/missing VBK1 header/);
  });

  test('the key must be 32 base64 bytes; unset means no encryption', () => {
    expect(backupEncryptionKey('')).toBeNull();
    expect(backupEncryptionKey(undefined)).toBeNull();
    expect(() => backupEncryptionKey('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  test('decryptBackup.js restores a backup with the key from the environment', async () => {
    const key = backupEncryptionKey(KEY_B64);
    const plain = path.join(tmp, 'dump.sql.gz');
    fs.writeFileSync(plain, Buffer.from('data'));
    await encryptFile(plain, `${plain}.enc`, key);
    process.env.BACKUP_ENCRYPTION_KEY = KEY_B64;

    await require('../src/scripts/decryptBackup').main([`${plain}.enc`, path.join(tmp, 'r.sql.gz')]);

    expect(fs.readFileSync(path.join(tmp, 'r.sql.gz'), 'utf8')).toBe('data');
  });
});

describe('backup() with BACKUP_ENCRYPTION_KEY', () => {
  function loadBackup(uploadBackup) {
    jest.resetModules();
    jest.doMock('../src/services/cloudStorageService', () => ({
      uploadBackup, resolveEnvConfig: () => null,
    }));
    jest.doMock('../src/services/backupSettingsService', () => ({
      getEffectiveRemoteConfig: async () => ({ bucket: 'b', source: 'settings' }),
    }));
    jest.doMock('../src/models/BackupRun', () => ({
      start: jest.fn().mockResolvedValue(1), finish: jest.fn().mockResolvedValue(),
    }));
    return require('../src/scripts/backup');
  }

  beforeEach(() => {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'mysqldump'), `#!/bin/sh\nhead -c 4096 /dev/zero | tr '\\0' 'x'\necho\n`);
    fs.chmodSync(path.join(binDir, 'mysqldump'), 0o755);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
    process.env.BACKUP_DIR = path.join(tmp, 'backups');
    // The fake dump compresses to a few dozen bytes.
    process.env.BACKUP_MIN_BYTES = '1';
    process.env.DB_NAME = 'fireisp';
  });

  test('uploads only the encrypted file and removes it afterwards', async () => {
    process.env.BACKUP_ENCRYPTION_KEY = KEY_B64;
    let uploaded = null;
    const uploadBackup = jest.fn(async (localPath, name) => {
      uploaded = { localPath, name, bytes: fs.readFileSync(localPath) };
      return `https://bucket/${name}`;
    });
    const { backup } = loadBackup(uploadBackup);

    const result = await backup();

    expect(result.remoteStatus).toBe('uploaded');
    expect(uploaded.name).toMatch(/^fireisp_.*\.sql\.gz\.enc$/);
    expect(uploaded.bytes.subarray(0, 4).toString()).toBe('VBK1');
    expect(fs.existsSync(uploaded.localPath)).toBe(false);
    // The local copy stays plain gzip, and the remote copy decrypts to it.
    const restored = path.join(tmp, 'restored.sql.gz');
    fs.writeFileSync(path.join(tmp, 'remote.enc'), uploaded.bytes);
    await decryptFile(path.join(tmp, 'remote.enc'), restored, backupEncryptionKey(KEY_B64));
    expect(fs.readFileSync(restored).equals(fs.readFileSync(result.filepath))).toBe(true);
    expect(zlib.gunzipSync(fs.readFileSync(result.filepath)).toString()).toMatch(/^x{4096}/);
  });

  test('a bad key fails the remote copy but keeps the local backup', async () => {
    process.env.BACKUP_ENCRYPTION_KEY = 'c2hvcnQ=';
    const uploadBackup = jest.fn();
    const { backup } = loadBackup(uploadBackup);

    const result = await backup();

    expect(result.remoteStatus).toBe('failed');
    expect(uploadBackup).not.toHaveBeenCalled();
    expect(fs.existsSync(result.filepath)).toBe(true);
  });

  test('without a key the plain dump is uploaded as before', async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    const uploadBackup = jest.fn().mockResolvedValue('https://bucket/x');
    const { backup } = loadBackup(uploadBackup);

    const result = await backup();

    expect(uploadBackup).toHaveBeenCalledWith(result.filepath, path.basename(result.filepath), expect.any(Object));
  });
});
