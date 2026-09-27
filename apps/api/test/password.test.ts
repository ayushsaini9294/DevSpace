import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../src/auth/password.ts';

describe('password hashing', () => {
  it('produces a self-describing scrypt string that is not the password', async () => {
    const hash = await hashPassword('correct horse battery');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    expect(Buffer.from(parts[4]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5]!, 'base64')).toHaveLength(64);
    expect(hash).not.toContain('correct horse battery');
  });

  it('uses a fresh salt each time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cret-password');
    expect(await verifyPassword('s3cret-password', hash)).toBe(true);
    expect(await verifyPassword('s3cret-passwore', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('returns false for malformed stored hashes instead of throwing', async () => {
    for (const stored of [
      '',
      'plain',
      'bcrypt$1$2$3$a$b',
      'scrypt$x$8$1$AAAA$AAAA',
      'scrypt$16384$8$1$$',
    ]) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('dummy verification always fails', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false);
  });
});
