import type { RequestHandler } from 'express';
import { env } from '../config/env.ts';
import { HttpError } from './http-error.ts';

/**
 * Defence in depth next to SameSite cookies and `requireJson`: any non-GET /api request
 * that says where it comes from (the `Origin` header) must come from the app itself. In
 * particular, the IDE site (a different origin, running members' code) can never call /api.
 * Requests without an Origin header (same-origin GETs, non-browser clients) are unaffected.
 */
export const requireAppOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.headers.origin;
  if (req.method === 'GET' || origin === undefined || origin === env.APP_ORIGIN) {
    next();
    return;
  }
  throw new HttpError(403, 'forbidden_origin', 'Requests must come from the DevSpace app');
};
