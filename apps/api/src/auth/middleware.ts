import type { RequestHandler } from 'express';
import { HttpError } from '../lib/http-error.ts';
import { findSessionUser, readSessionToken, sessionCookie, type AuthUser } from './session.ts';

declare global {
  // Express declaration merging requires the namespace form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `loadSession` when the request carries a valid session cookie. */
      user?: AuthUser;
    }
  }
}

/**
 * Attaches `req.user` when the session cookie is valid. Never rejects: routes that need a
 * user add `requireAuth`. An unknown or expired cookie is cleared.
 */
export const loadSession: RequestHandler = async (req, res, next) => {
  const token = readSessionToken(req.cookies);
  if (!token) {
    next();
    return;
  }
  const user = await findSessionUser(token);
  if (user) req.user = user;
  else res.clearCookie(sessionCookie.name, sessionCookie.clear);
  next();
};

/** 401 `unauthenticated` unless `loadSession` found a user. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'unauthenticated', 'Not logged in');
  next();
};
