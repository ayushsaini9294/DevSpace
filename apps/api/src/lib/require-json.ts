import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { HttpError } from './http-error.ts';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasNoBody(headers: IncomingHttpHeaders): boolean {
  const length = headers['content-length'];
  return (
    headers['content-type'] === undefined &&
    headers['transfer-encoding'] === undefined &&
    (length === undefined || length === '0')
  );
}

/**
 * CSRF baseline. Session cookies are SameSite=Lax, so browsers don't attach them to
 * cross-site POSTs from scripts. What remains is a plain HTML form, which can only send
 * urlencoded, multipart or text/plain bodies. Requiring `Content-Type: application/json` on
 * every state-changing /api request (a cross-site page can't send it without a CORS
 * preflight, which we never allow) blocks those. Exceptions, both with no body and no
 * Content-Type at all: POST /api/auth/logout, and DELETE (HTML forms can't send DELETE, and
 * a cross-site script can't either without a preflight).
 */
export const requireJson: RequestHandler = (req, _res, next) => {
  if (!STATE_CHANGING.has(req.method) || req.is('application/json')) {
    next();
    return;
  }
  const bodilessAllowed =
    req.method === 'DELETE' || (req.method === 'POST' && req.path === '/auth/logout');
  if (bodilessAllowed && hasNoBody(req.headers)) {
    next();
    return;
  }
  throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
};
