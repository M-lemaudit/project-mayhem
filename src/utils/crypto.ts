/**
 * Client password encryption for Agency Model. Uses AES-256-CBC.
 * Config: ENCRYPTION_KEY (32 chars), IV_LENGTH (default 16) from process.env.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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
 */
export function encrypt(text: string): string {
  const key = getKey();
  const ivLen = getIvLength();
  const iv = randomBytes(ivLen);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypts "iv:encryptedHex" back to plaintext.
 */
export function decrypt(text: string): string {
  const sep = text.indexOf(':');
  if (sep === -1) {
    throw new Error('Invalid encrypted format: expected "iv:encryptedHex"');
  }
  const ivHex = text.slice(0, sep);
  const encHex = text.slice(sep + 1);
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encHex, 'hex'), decipher.final()]).toString('utf-8');
}

/**
 * Returns true if the string looks like our encrypted format (contains ":" and plausible iv:hex structure).
 */
export function looksEncrypted(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const sep = text.indexOf(':');
  if (sep === -1) return false;
  const ivPart = text.slice(0, sep);
  const encPart = text.slice(sep + 1);
  return /^[0-9a-fA-F]+$/.test(ivPart) && /^[0-9a-fA-F]+$/.test(encPart);
}
