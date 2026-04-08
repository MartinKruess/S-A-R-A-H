import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto.js';
import { randomBytes } from 'crypto';

describe('crypto', () => {
  const key = randomBytes(32);

  it('encrypts and decrypts a string', () => {
    const plaintext = 'Hello Sarah';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts JSON objects', () => {
    const obj = { name: 'Sarah', city: 'Berlin', nested: { a: 1 } };
    const encrypted = encrypt(JSON.stringify(obj), key);
    const decrypted = JSON.parse(decrypt(encrypted, key));
    expect(decrypted).toEqual(obj);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same input';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with wrong key', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const encrypted = encrypt('secret', key);
    const tampered = encrypted.slice(0, -4) + 'xxxx';
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('handles empty string', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  it('handles unicode', () => {
    const text = 'Schöne Grüße aus Köln 🚀';
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });
});
