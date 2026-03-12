// =============================================================================
// KULT Platform — AES-256-GCM Symmetric Encryption
//
// Used exclusively for encrypting hot-wallet private keys at rest.
//
// Wire format (returned as a single colon-delimited string):
//   <iv-hex>:<authTag-hex>:<ciphertext-hex>
//
// Properties:
//   - AES-256-GCM: authenticated encryption, detects tampering
//   - Unique 12-byte IV per encryption — safe for up to 2^32 encryptions
//   - 16-byte auth tag — standard GCM tag length
//   - Key derivation: PBKDF2-SHA256 stretches the raw ENCRYPTION_KEY to 32 bytes
//     so the caller does not need to supply an exact 32-byte key
// =============================================================================

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

/** A fixed, non-secret salt baked into the binary.
 *  The real security comes from the ENCRYPTION_KEY being secret.
 *  If you need per-instance salting, store a random salt alongside the ciphertext.
 */
const STATIC_SALT = Buffer.from('kult-platform-hot-wallet-encryption-salt-v1');

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a 32-byte AES key from a raw passphrase using PBKDF2-SHA256.
 * The result is memoised per unique key string to avoid redundant work on
 * the hot path.
 */
const keyCache = new Map<string, Buffer>();

function deriveKey(rawKey: string): Buffer {
  const cached = keyCache.get(rawKey);
  if (cached !== undefined) return cached;

  const derived = pbkdf2Sync(
    rawKey,
    STATIC_SALT,
    PBKDF2_ITERATIONS,
    KEY_BYTES,
    PBKDF2_DIGEST
  );

  // Limit cache size to prevent unbounded growth (in practice only one key is used)
  if (keyCache.size >= 8) keyCache.clear();
  keyCache.set(rawKey, derived);
  return derived;
}

// ---------------------------------------------------------------------------
// Encrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts `plaintext` with AES-256-GCM using `key`.
 *
 * @param plaintext - The string to encrypt (e.g. a private key hex string)
 * @param key       - The encryption key (at least 32 printable chars recommended)
 * @returns A colon-delimited string: `<iv-hex>:<authTag-hex>:<ciphertext-hex>`
 *
 * ```ts
 * const encrypted = encrypt(privateKeyHex, config.ENCRYPTION_KEY);
 * // "a1b2c3...:d4e5f6...:7890ab..."
 * ```
 */
export function encrypt(plaintext: string, key: string): string {
  if (!plaintext) throw new TypeError('plaintext must not be empty');
  if (!key) throw new TypeError('key must not be empty');

  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

// ---------------------------------------------------------------------------
// Decrypt
// ---------------------------------------------------------------------------

/**
 * Decrypts a ciphertext string produced by `encrypt()`.
 *
 * @param ciphertext - The colon-delimited string from `encrypt()`
 * @param key        - The same key used during encryption
 * @returns The original plaintext string
 * @throws If the ciphertext is malformed, the key is wrong, or the auth tag fails
 *
 * ```ts
 * const privateKey = decrypt(encryptedWallet.encryptedPrivateKey, config.ENCRYPTION_KEY);
 * ```
 */
export function decrypt(ciphertext: string, key: string): string {
  if (!ciphertext) throw new TypeError('ciphertext must not be empty');
  if (!key) throw new TypeError('key must not be empty');

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Malformed ciphertext: expected format <iv>:<authTag>:<data>'
    );
  }

  const [ivHex, authTagHex, dataHex] = parts as [string, string, string];

  let iv: Buffer;
  let authTag: Buffer;
  let encryptedData: Buffer;

  try {
    iv = Buffer.from(ivHex, 'hex');
    authTag = Buffer.from(authTagHex, 'hex');
    encryptedData = Buffer.from(dataHex, 'hex');
  } catch {
    throw new Error('Malformed ciphertext: invalid hex encoding');
  }

  if (iv.length !== IV_BYTES) {
    throw new Error(
      `Malformed ciphertext: IV must be ${IV_BYTES} bytes, got ${iv.length}`
    );
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `Malformed ciphertext: auth tag must be ${AUTH_TAG_BYTES} bytes, got ${authTag.length}`
    );
  }

  const derivedKey = deriveKey(key);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encryptedData),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // GCM auth failure — key is wrong or data was tampered
    throw new Error(
      'Decryption failed: authentication tag mismatch. The key may be incorrect or the ciphertext was tampered with.'
    );
  }
}

// ---------------------------------------------------------------------------
// Utility: constant-time comparison
// ---------------------------------------------------------------------------

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Use this when comparing secrets (e.g. API keys, HMAC digests).
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Utility: generate secure random string
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically secure random hex string of the given byte length.
 *
 * ```ts
 * const apiKey = generateSecureRandom(32); // 64-char hex string
 * ```
 */
export function generateSecureRandom(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Self-test (runs once at module load in non-production to catch misconfiguration)
// ---------------------------------------------------------------------------

(function selfTest(): void {
  const testKey = 'kult-platform-self-test-key-32-bytes!';
  const testPlain = 'self-test-plaintext-value';

  try {
    const enc = encrypt(testPlain, testKey);
    const dec = decrypt(enc, testKey);
    if (dec !== testPlain) {
      throw new Error('encrypt/decrypt round-trip mismatch');
    }
  } catch (err) {
    // This should never happen — if it does, the crypto module is broken
    console.error('[encryption] CRITICAL: self-test failed:', err);
    process.exit(1);
  }
})();
