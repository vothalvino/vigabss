// =============================================================================
// VigaBSS 5.0 — AES-256-GCM Envelope Encryption
// =============================================================================
// Encrypts / decrypts sensitive data (payment gateway secrets, PAC passwords,
// CSD private keys, webhook secrets) at the application layer.
//
// Requires ENCRYPTION_KEY env var — a 64-character hex string (256 bits).
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Key rotation (SEC-28): every ciphertext names the key that sealed it,
//   vb1:<key id>:<iv>:<auth tag>:<ciphertext>   (all hex)
// where the key id is the first 8 hex digits of SHA-256(key). To rotate, set
// the new key as ENCRYPTION_KEY and list the old one in
// ENCRYPTION_KEYS_PREVIOUS (comma-separated): previous keys only decrypt.
// Then run src/scripts/rotate-encryption-key.js, which finds every value
// sealed by another key in every text column and seals it again with the
// current one, and drop the old key once it reports none left.
// =============================================================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;     // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;    // 128-bit auth tag
const ENCODING = 'hex';
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;
const PREFIX = 'vb1';
// One sealed value; the `g` form finds them inside a larger text or JSON value.
const CIPHERTEXT_RE = /^vb1:([0-9a-f]{8}):([0-9a-f]{24}):([0-9a-f]{32}):((?:[0-9a-f]{2})*)$/;
const CIPHERTEXT_GLOBAL_RE = /vb1:([0-9a-f]{8}):([0-9a-f]{24}):([0-9a-f]{32}):((?:[0-9a-f]{2})*)/g;

function parseKey(hex, name) {
  if (!HEX_64_RE.test(hex)) {
    throw new Error(`${name} must be a 64-character hex string (256 bits)`);
  }
  return Buffer.from(hex, 'hex');
}

/** The id a ciphertext carries for a key: 8 hex digits of its SHA-256. */
function keyIdOf(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * Derive the 256-bit encryption key from the ENCRYPTION_KEY env var.
 * Returns null when the env var is not set (encryption disabled).
 */
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  return parseKey(hex, 'ENCRYPTION_KEY');
}

/** The current key, then each ENCRYPTION_KEYS_PREVIOUS key: [{ id, key }]. */
function keyRing() {
  const current = getKey();
  if (!current) return [];
  const previous = String(process.env.ENCRYPTION_KEYS_PREVIOUS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(hex => parseKey(hex, 'Each ENCRYPTION_KEYS_PREVIOUS entry'));
  return [current, ...previous].map(key => ({ id: keyIdOf(key), key }));
}

/** The current key's id, or null when encryption is disabled. */
function currentKeyId() {
  const key = getKey();
  return key ? keyIdOf(key) : null;
}

function seal(key, plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${keyIdOf(key)}:${iv.toString(ENCODING)}:${tag.toString(ENCODING)}:${encrypted.toString(ENCODING)}`;
}

/**
 * Open one sealed value. Throws { code: 'ENCRYPTION_KEY_UNKNOWN' } when no
 * configured key has its id, and an authentication error when the bytes do
 * not verify.
 */
function open(match, ring) {
  const [, kid, ivHex, tagHex, encHex] = match;
  const entry = ring.find(k => k.id === kid);
  if (!entry) {
    throw Object.assign(new Error(`No configured key has id ${kid} (set it in ENCRYPTION_KEYS_PREVIOUS)`), {
      code: 'ENCRYPTION_KEY_UNKNOWN',
    });
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, entry.key, Buffer.from(ivHex, ENCODING), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(Buffer.from(tagHex, ENCODING));
  return Buffer.concat([decipher.update(Buffer.from(encHex, ENCODING)), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a plaintext string with the current key (format above).
 *
 * When ENCRYPTION_KEY is not configured the plaintext is returned as-is
 * so that development / test environments work without encryption.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;

  const key = getKey();
  if (!key) return plaintext; // encryption disabled
  return seal(key, plaintext);
}

/**
 * Decrypt a value produced by `encrypt()`, with whichever configured key
 * sealed it.
 *
 * When ENCRYPTION_KEY is not configured, or the value is not in the sealed
 * format, or no configured key opens it, the value is returned as-is (it is
 * taken to be plaintext). Use decryptStrict for long-lived credentials.
 *
 * @param {string} ciphertext
 * @returns {string}
 */
function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;

  const ring = keyRing();
  if (!ring.length) return ciphertext; // encryption disabled
  const match = CIPHERTEXT_RE.exec(String(ciphertext));
  if (!match) return ciphertext;
  try {
    return open(match, ring);
  } catch (_err) {
    return ciphertext;
  }
}

function encryptionConfigurationError() {
  return Object.assign(new Error('Encryption is required for this secret but ENCRYPTION_KEY is unavailable.'), {
    code: 'ENCRYPTION_NOT_CONFIGURED',
  });
}

function invalidCiphertextError() {
  return Object.assign(new Error('Encrypted secret could not be authenticated.'), {
    code: 'ENCRYPTED_SECRET_INVALID',
  });
}

/**
 * Fail-closed variants for long-lived credentials. Unlike the compatibility
 * helpers above, these functions never persist or accept legacy plaintext.
 */
function encryptStrict(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (!getKey()) throw encryptionConfigurationError();
  return encrypt(plaintext);
}

function decryptStrict(ciphertext) {
  if (ciphertext === null || ciphertext === undefined) return ciphertext;
  const ring = keyRing();
  if (!ring.length) throw encryptionConfigurationError();

  const match = CIPHERTEXT_RE.exec(String(ciphertext));
  if (!match) throw invalidCiphertextError();
  try {
    return open(match, ring);
  } catch (err) {
    if (err.code === 'ENCRYPTION_KEY_UNKNOWN') throw err;
    throw invalidCiphertextError();
  }
}

/**
 * Seal again with the current key every value inside `text` that another
 * configured key sealed (a column may hold one sealed value or embed several
 * in JSON). Returns { text, resealed, unknown }: `unknown` counts values whose
 * key is not configured, which are left as they are.
 *
 * @param {string} text
 */
function resealWithCurrentKey(text) {
  const ring = keyRing();
  if (!ring.length) throw encryptionConfigurationError();
  const [current] = ring;
  let resealed = 0;
  let unknown = 0;
  const out = String(text).replace(CIPHERTEXT_GLOBAL_RE, (sealed, kid, ...rest) => {
    if (kid === current.id) return sealed;
    let plaintext;
    try {
      plaintext = open([sealed, kid, ...rest.slice(0, 3)], ring);
    } catch (_err) {
      unknown++;
      return sealed;
    }
    resealed++;
    return seal(current.key, plaintext);
  });
  return { text: out, resealed, unknown };
}

/**
 * True when ENCRYPTION_KEY is configured — i.e. encrypt() actually encrypts.
 * Callers storing long-lived secrets (CSD private keys) must refuse to write
 * in production when this is false: the "encrypted" columns would silently
 * hold plaintext.
 */
function isConfigured() {
  return getKey() !== null;
}

module.exports = {
  encrypt,
  decrypt,
  encryptStrict,
  decryptStrict,
  resealWithCurrentKey,
  getKey,
  keyRing,
  currentKeyId,
  isConfigured,
  CIPHERTEXT_GLOBAL_RE,
};
