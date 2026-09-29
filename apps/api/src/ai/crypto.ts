import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';

/**
 * Secrets at rest (Phase 10): AES-256-GCM with AI_SECRETS_KEY and a random 12-byte IV per
 * value. Stored as `v1.<iv>.<tag>.<ciphertext>` (base64url). The plaintext is never logged;
 * a value that fails to decrypt (wrong key, tampering) throws a message without it.
 */

const VERSION = 'v1';

export function encryptSecret(plaintext: string, key: Buffer = env.AI_SECRETS_KEY): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export class SecretDecryptError extends Error {
  constructor() {
    super(
      'A stored secret could not be decrypted (AI_SECRETS_KEY changed or the value is damaged)',
    );
    this.name = 'SecretDecryptError';
  }
}

export function decryptSecret(stored: string, key: Buffer = env.AI_SECRETS_KEY): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretDecryptError();
  try {
    const [iv, tag, data] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
    if (iv!.length !== 12 || tag!.length !== 16) throw new SecretDecryptError();
    const decipher = createDecipheriv('aes-256-gcm', key, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}
