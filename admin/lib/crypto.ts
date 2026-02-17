/**
 * Client password encryption (duplicate of Bot backend for Server Actions).
 * Uses AES-256-CBC. Same ENCRYPTION_KEY and IV_LENGTH as the bot.
 */

import { createCipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-cbc';
const DEFAULT_IV_LENGTH = 16;
const REQUIRED_KEY_BYTES = 32;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string') {
    throw new Error('ENCRYPTION_KEY must be set in environment');
  }
  const buf = Buffer.from(raw, 'utf-8');
  if (buf.length < REQUIRED_KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must be at least ${REQUIRED_KEY_BYTES} characters`);
  }
  return Buffer.from(buf.subarray(0, REQUIRED_KEY_BYTES));
}

function getIvLength(): number {
  const raw = process.env.IV_LENGTH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IV_LENGTH;
}

/**
 * Encrypts plaintext. Returns "iv:encryptedHex" (IV and ciphertext as hex).
 * Use this before saving password to Supabase.
 */
export function encrypt(text: string): string {
  const key = getKey();
  const ivLen = getIvLength();
  const iv = randomBytes(ivLen);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}
