import { Router, type Response } from 'express';
import {
  AuthResponseSchema,
  LogInRequestSchema,
  SignUpRequestSchema,
  type AuthResponse,
} from '@devspace/shared';
import { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';
import { HttpError } from '../lib/http-error.ts';
import { parseBody } from '../lib/validate.ts';
import { requireAuth } from './middleware.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import {
  authUserSelect,
  createSession,
  deleteSession,
  hashSessionToken,
  newSessionToken,
  readSessionToken,
  sessionCookie,
  type AuthUser,
} from './session.ts';
import { disconnectSession } from '../realtime/emitter.ts';

export const authRouter = Router();

const emailTaken = () =>
  new HttpError(409, 'email_taken', 'An account with this email already exists');
const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

function toAuthResponse(user: AuthUser): AuthResponse {
  // Parsing strips anything not in the contract, so no other column can leak.
  return AuthResponseSchema.parse({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt.toISOString(),
    },
  });
}

function sendAuth(res: Response, status: number, user: AuthUser, token: string): void {
  res.cookie(sessionCookie.name, token, sessionCookie.set);
  res.set('Cache-Control', 'no-store');
  res.status(status).json(toAuthResponse(user));
}

authRouter.post('/signup', async (req, res) => {
  const { name, email, password } = parseBody(SignUpRequestSchema, req.body);

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw emailTaken();
  }

  const passwordHash = await hashPassword(password);
  const { token, id, expiresAt } = newSessionToken();
  let user: AuthUser;
  try {
    // User and first session are created together, so a failure leaves neither behind.
    user = await prisma.user.create({
      data: { name, email, passwordHash, sessions: { create: { id, expiresAt } } },
      select: authUserSelect,
    });
  } catch (err) {
    // Two signups with the same email racing past the check above.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw emailTaken();
    }
    throw err;
  }
  sendAuth(res, 201, user, token);
});

authRouter.post('/login', async (req, res) => {
  const { email, password } = parseBody(LogInRequestSchema, req.body);

  const found = await prisma.user.findUnique({
    where: { email },
    select: { ...authUserSelect, passwordHash: true },
  });
  // An unknown email still runs a full scrypt verify, so both failures take about as long.
  const ok = found
    ? await verifyPassword(password, found.passwordHash)
    : await verifyAgainstDummy(password);
  if (!found || !ok) throw invalidCredentials();

  const user: AuthUser = {
    id: found.id,
    name: found.name,
    email: found.email,
    createdAt: found.createdAt,
  };
  const { token } = await createSession(user.id);
  sendAuth(res, 200, user, token);
});

authRouter.post('/logout', async (req, res) => {
  const token = readSessionToken(req.cookies);
  if (token) {
    await deleteSession(token);
    // Its live connections end too (Phase 9).
    disconnectSession(hashSessionToken(token));
  }
  res.clearCookie(sessionCookie.name, sessionCookie.clear);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json(toAuthResponse(req.user as AuthUser));
});
