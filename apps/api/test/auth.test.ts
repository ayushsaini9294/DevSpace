import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthResponseSchema, ErrorResponseSchema, SESSION_COOKIE_NAME } from '@devspace/shared';
import { createApp } from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { hashSessionToken } from '../src/auth/session.ts';

const app = createApp();
const createdEmails: string[] = [];
const PASSWORD = 'a-good-password';

function uniqueEmail(prefix = 'user'): string {
  const email = `${prefix}-${randomUUID()}@example.test`;
  createdEmails.push(email.toLowerCase());
  return email;
}

function cookieHeader(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as unknown;
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === 'string' ? [raw] : [];
}

function sessionToken(res: request.Response): string {
  const cookie = cookieHeader(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error('no session cookie set');
  return cookie.split(';')[0]!.slice(SESSION_COOKIE_NAME.length + 1);
}

async function signUp(email = uniqueEmail(), password = PASSWORD) {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ name: 'Test User', email, password });
  expect(res.status).toBe(201);
  return { res, email, token: sessionToken(res) };
}

const asCookie = (token: string) => `${SESSION_COOKIE_NAME}=${token}`;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

describe('POST /api/auth/signup', () => {
  it('creates the user, sets an HttpOnly session cookie, and /me returns the user', async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ name: '  Ada Lovelace ', email, password: PASSWORD });
    expect(res.status).toBe(201);
    const body = AuthResponseSchema.parse(res.body);
    expect(body.user).toMatchObject({ name: 'Ada Lovelace', email });
    expect(Object.keys(res.body.user).sort()).toEqual(['createdAt', 'email', 'id', 'name']);

    const cookie = cookieHeader(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);

    // Only the hash of the token is stored.
    const token = sessionToken(res);
    const session = await prisma.session.findUnique({ where: { id: hashSessionToken(token) } });
    expect(session?.userId).toBe(body.user.id);
    expect(await prisma.session.count({ where: { id: token } })).toBe(0);

    const me = await request(app).get('/api/auth/me').set('Cookie', asCookie(token));
    expect(me.status).toBe(200);
    expect(AuthResponseSchema.parse(me.body)).toEqual(body);
  });

  it('stores a scrypt hash, never the plain password', async () => {
    const { email } = await signUp();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).not.toBe(PASSWORD);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/);
  });

  it('rejects a duplicate email with 409 email_taken', async () => {
    const { email } = await signUp();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Other', email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'email_taken',
      message: 'An account with this email already exists',
    });
    expect(cookieHeader(res).some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(false);
  });

  it('handles concurrent signups with the same email (one 201, one 409)', async () => {
    const email = uniqueEmail('race');
    const send = () =>
      request(app).post('/api/auth/signup').send({ name: 'Racer', email, password: PASSWORD });
    const statuses = (await Promise.all([send(), send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('returns 400 validation_error with per-field messages', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ name: '   ', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    const body = ErrorResponseSchema.parse(res.body);
    expect(body.error).toBe('validation_error');
    expect(Object.keys(body.fields ?? {}).sort()).toEqual(['email', 'name', 'password']);
    expect(body.fields?.name).toContain('Enter your name');
    expect(body.fields?.password).toContain('Use at least 8 characters');
  });

  it('returns 400 validation_error for missing fields', async () => {
    const res = await request(app).post('/api/auth/signup').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(Object.keys(res.body.fields).sort()).toEqual(['email', 'name', 'password']);
  });
});

describe('POST /api/auth/login', () => {
  it('treats email case-insensitively (sign up Mixed@Case, log in lowercase)', async () => {
    const id = randomUUID();
    const mixed = `Mixed-${id}@Case.Example.Test`;
    createdEmails.push(mixed.toLowerCase());
    const { res: signup } = await signUp(mixed);
    expect(signup.body.user.email).toBe(mixed.toLowerCase());

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: mixed.toLowerCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(AuthResponseSchema.parse(res.body).user.id).toBe(signup.body.user.id);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', asCookie(sessionToken(res)));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(mixed.toLowerCase());
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const { email } = await signUp();
    const wrong = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'not-the-password' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: `nobody-${randomUUID()}@example.test`, password: PASSWORD });

    const expected = { error: 'invalid_credentials', message: 'Email or password is incorrect' };
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(expected);
    expect(unknown.body).toEqual(expected);
    expect(cookieHeader(wrong)).toEqual([]);
    expect(cookieHeader(unknown)).toEqual([]);
  });

  it('returns 400 validation_error for an empty password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@example.test', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.fields.password).toContain('Enter your password');
  });
});

describe('GET /api/auth/me and sessions', () => {
  it('returns 401 unauthenticated without a cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated', message: 'Not logged in' });
  });

  it('returns 401 for an unknown token', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', asCookie('bogus-token'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
  });

  it('treats an expired session as missing and deletes its row', async () => {
    const { token } = await signUp();
    const id = hashSessionToken(token);
    await prisma.session.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).get('/api/auth/me').set('Cookie', asCookie(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
    expect(await prisma.session.count({ where: { id } })).toBe(0);
  });
});

describe('POST /api/auth/logout', () => {
  it('deletes the session row, clears the cookie, and /me is then 401', async () => {
    const { token } = await signUp();
    const id = hashSessionToken(token);
    expect(await prisma.session.count({ where: { id } })).toBe(1);

    // Empty body, no Content-Type: allowed for logout only.
    const res = await request(app).post('/api/auth/logout').set('Cookie', asCookie(token));
    expect(res.status).toBe(204);
    expect(await prisma.session.count({ where: { id } })).toBe(0);
    const cleared = cookieHeader(res).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    const me = await request(app).get('/api/auth/me').set('Cookie', asCookie(token));
    expect(me.status).toBe(401);
  });

  it('also accepts a JSON body', async () => {
    const { token } = await signUp();
    const res = await request(app).post('/api/auth/logout').set('Cookie', asCookie(token)).send({});
    expect(res.status).toBe(204);
    expect(await prisma.session.count({ where: { id: hashSessionToken(token) } })).toBe(0);
  });

  it('returns 204 when not logged in', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
  });

  it('only ends its own session', async () => {
    const { email, token: first } = await signUp();
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    const second = sessionToken(login);
    await request(app).post('/api/auth/logout').set('Cookie', asCookie(first));
    const me = await request(app).get('/api/auth/me').set('Cookie', asCookie(second));
    expect(me.status).toBe(200);
  });
});

describe('CSRF baseline: JSON only for state-changing requests', () => {
  it('rejects a form-encoded signup with 415', async () => {
    const res = await request(app)
      .post('/api/auth/signup')
      .type('form')
      .send({ name: 'Form', email: uniqueEmail(), password: PASSWORD });
    expect(res.status).toBe(415);
    expect(res.body).toEqual({
      error: 'unsupported_media_type',
      message: 'Content-Type must be application/json',
    });
  });

  it('rejects text/plain login with 415', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'text/plain')
      .send('{"email":"a@example.test","password":"x"}');
    expect(res.status).toBe(415);
  });

  it('rejects a form-encoded logout with 415 and keeps the session', async () => {
    const { token } = await signUp();
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', asCookie(token))
      .type('form')
      .send('x=1');
    expect(res.status).toBe(415);
    expect(await prisma.session.count({ where: { id: hashSessionToken(token) } })).toBe(1);
  });
});

describe('error bodies', () => {
  it('malformed JSON returns 400 matching ErrorResponseSchema', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual({
      error: 'bad_request',
      message: 'Bad request',
    });
  });

  it('never returns password_hash / passwordHash from any auth response', async () => {
    const email = uniqueEmail();
    const bodies = [];
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ name: 'Leak Check', email, password: PASSWORD });
    bodies.push(signup);
    const token = sessionToken(signup);
    bodies.push(await request(app).get('/api/auth/me').set('Cookie', asCookie(token)));
    bodies.push(await request(app).post('/api/auth/login').send({ email, password: PASSWORD }));
    bodies.push(await request(app).post('/api/auth/login').send({ email, password: 'wrong-pw' }));
    bodies.push(
      await request(app).post('/api/auth/signup').send({ name: 'X', email, password: PASSWORD }),
    );
    const stored = (await prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash;
    for (const res of bodies) {
      expect(res.text).not.toMatch(/password_?hash/i);
      expect(res.text).not.toContain(stored);
      expect(res.text).not.toContain(PASSWORD);
    }
  });
});
