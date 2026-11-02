// =============================================================================
// Client-side encryption of off-site backups (ASY-30)
// =============================================================================
// The remote copy was only gzipped, so anyone with read access to the bucket
// (or its provider) could read the whole database. With BACKUP_ENCRYPTION_KEY
// set, the dump is encrypted before upload with AES-256-GCM:
//
//   'VBK1' (4 bytes) | IV (12 bytes) | ciphertext | auth tag (16 bytes)
//
// The magic is authenticated as associated data. The local copy in
// storage/backups stays plain gzip. Restore with src/scripts/decryptBackup.js.
// Losing the key makes every encrypted remote backup unrecoverable.
// =============================================================================

const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('VBK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

/** The configured key, or null when remote backups are not encrypted. */
function backupEncryptionKey(raw = process.env.BACKUP_ENCRYPTION_KEY) {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  return key;
}

async function encryptFile(source, destination, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  fs.writeFileSync(destination, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
  await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(destination, { flags: 'a' }));
  fs.appendFileSync(destination, cipher.getAuthTag());
}

async function decryptFile(source, destination, key) {
  const { size } = fs.statSync(source);
  const fd = fs.openSync(source, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error('Not an encrypted VigaBSS backup: file too short');
    fs.readSync(fd, header, 0, HEADER_BYTES, 0);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not an encrypted VigaBSS backup: missing VBK1 header');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    // An empty ciphertext has no byte range to read.
    const body = size - TAG_BYTES > HEADER_BYTES
      ? fs.createReadStream(source, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 })
      : require('stream').Readable.from([]);
    await pipeline(body, decipher, fs.createWriteStream(destination, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(destination, { force: true });
    throw new Error(`Backup decryption failed (wrong key or corrupted file): ${err.message}`, { cause: err });
  }
}

module.exports = { backupEncryptionKey, encryptFile, decryptFile, MAGIC };
