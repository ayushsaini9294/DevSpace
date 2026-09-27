import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt parameters. Memory use is 128 * N * r bytes (16 MiB here); maxmem leaves headroom.
const N = 16384; // 2^14
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 64 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes a password as `scrypt$N$r$p$<salt base64>$<hash base64>` with a random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Checks a password against a stored hash with a constant-time comparison.
 * Returns false (never throws) for a malformed stored hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    salt.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }
  try {
    const actual = await scryptAsync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: MAX_MEM,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// A real hash of a random password, created on first use.
let dummyHash: Promise<string> | undefined;

/**
 * Runs a full verify against a throwaway hash and resolves false. Used when a login email is
 * unknown, so that case takes about as long as a wrong password.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
  await verifyPassword(password, await dummyHash);
  return false;
}
