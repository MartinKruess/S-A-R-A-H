import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MIN_ENVELOPE_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class CryptoEnvelopeError extends Error {
  readonly code = 'INVALID_CRYPTO_ENVELOPE';

  constructor(message = 'Encrypted envelope is not canonical base64 or is too short') {
    super(message);
    this.name = 'CryptoEnvelopeError';
  }
}

function decodeEnvelope(ciphertext: string): Buffer {
  if (
    ciphertext.length === 0
    || ciphertext.length % 4 !== 0
    || !CANONICAL_BASE64_PATTERN.test(ciphertext)
  ) {
    throw new CryptoEnvelopeError();
  }
  const data = Buffer.from(ciphertext, 'base64');
  if (data.length < MIN_ENVELOPE_LENGTH || data.toString('base64') !== ciphertext) {
    throw new CryptoEnvelopeError();
  }
  return data;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64 string: IV (12 bytes) + ciphertext + authTag (16 bytes).
 */
export function encrypt(plaintext: string, key: Buffer, additionalData?: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (additionalData !== undefined) cipher.setAAD(Buffer.from(additionalData, 'utf8'));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * Decrypt a base64 string produced by encrypt().
 * Throws on wrong key or tampered data.
 */
export function decrypt(ciphertext: string, key: Buffer, additionalData?: string): string {
  const data = decodeEnvelope(ciphertext);

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (additionalData !== undefined) decipher.setAAD(Buffer.from(additionalData, 'utf8'));
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}
