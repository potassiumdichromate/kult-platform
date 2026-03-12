import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_DIGEST = 'sha512';

/**
 * Derives a 256-bit key from the master encryption key using PBKDF2.
 * A random salt is generated per-encryption so each encrypted blob has unique key derivation.
 */
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    Buffer.from(masterKey, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

export interface EncryptedPayload {
  /** hex-encoded: salt (32) + iv (16) + authTag (16) + ciphertext */
  ciphertext: string;
  version: number;
}

/**
 * Encrypts a private key string using AES-256-GCM with PBKDF2 key derivation.
 * The output is a single hex string encoding: version(1B) + salt(32B) + iv(16B) + tag(16B) + ciphertext.
 *
 * SECURITY: The master ENCRYPTION_KEY environment variable is NEVER stored — only the derived key
 * is held in memory transiently during encryption and is immediately GC-eligible after this call.
 */
export function encryptPrivateKey(privateKey: string): string {
  const masterKey = process.env['ENCRYPTION_KEY'];
  if (!masterKey || masterKey.length < 32) {
    throw new Error('ENCRYPTION_KEY environment variable is not set or too short');
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const derivedKey = deriveKey(masterKey, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(privateKey, 'utf8')),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Version byte (0x01) + salt + iv + authTag + ciphertext
  const version = Buffer.alloc(1);
  version.writeUInt8(1, 0);

  const combined = Buffer.concat([version, salt, iv, authTag, encrypted]);

  // Zero out the derived key from memory as soon as possible
  derivedKey.fill(0);

  return combined.toString('hex');
}

/**
 * Decrypts an AES-256-GCM encrypted private key.
 * The decrypted string is returned and the caller is responsible for zeroing it after use.
 *
 * SECURITY: This function must only be called transiently during signing operations.
 * The result must NEVER be logged, stored, or returned to any API caller.
 */
export function decryptPrivateKey(encryptedHex: string): string {
  const masterKey = process.env['ENCRYPTION_KEY'];
  if (!masterKey || masterKey.length < 32) {
    throw new Error('ENCRYPTION_KEY environment variable is not set or too short');
  }

  const combined = Buffer.from(encryptedHex, 'hex');

  // Parse the version byte
  const version = combined.readUInt8(0);
  if (version !== 1) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  let offset = 1;
  const salt = combined.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = combined.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = combined.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = combined.subarray(offset);

  const derivedKey = deriveKey(masterKey, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Zero derived key before re-throwing
    derivedKey.fill(0);
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  derivedKey.fill(0);
  const result = decrypted.toString('utf8');

  // Zero the buffer
  decrypted.fill(0);

  return result;
}

/**
 * Validates that the ENCRYPTION_KEY is present and meets minimum length requirements.
 * Called at service startup.
 */
export function validateEncryptionKey(): void {
  const key = process.env['ENCRYPTION_KEY'];
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  if (key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
  }
}
