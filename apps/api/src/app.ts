import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { env } from './config/env.ts';
import { limits } from './lib/rate-limit.ts';
import cookieParser from 'cookie-parser';
import type { ErrorResponse } from '@devspace/shared';
import { healthRouter } from './routes/health.ts';
import { authRouter } from './auth/routes.ts';
import { loadSession, requireAuth } from './auth/middleware.ts';
import { HttpError } from './lib/http-error.ts';
import { requireJson } from './lib/require-json.ts';
import { teamsRouter } from './teams/routes.ts';
import { projectsRouter } from './projects/routes.ts';
import { invitationsRouter } from './invitations/routes.ts';
import { requireAppOrigin } from './lib/require-origin.ts';
import { meRouter, notificationsRouter } from './notifications/routes.ts';
import { aiRouter } from './ai/routes.ts';
import { templatesRouter } from './repository/routes.ts';
import { githubRouter } from './github/routes.ts';

export interface AppOptions {
  /** Express `trust proxy` (default TRUST_PROXY; tests pass their own). */
  trustProxy?: boolean | number | string;
}

/** Security headers on every /api response (Phase 14); JSON answers are never cached. */
const apiHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
  });
  next();
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Caddy (TRUST_PROXY=loopback) req.ip is the real client, for rate limits and logs.
  app.set('trust proxy', options.trustProxy ?? env.TRUST_PROXY);
  app.use('/api', apiHeaders);
  // The IDE is served by its own listener on its own site (ide/proxy.ts), never from here.
  app.use('/api', requireAppOrigin);
  app.use('/api', requireJson);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', loadSession);
  app.use('/api', limits.general);

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/teams', requireAuth, teamsRouter);
  app.use('/api/projects', requireAuth, projectsRouter);
  app.use('/api/invitations', requireAuth, invitationsRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);
  app.use('/api/me', requireAuth, meRouter);
  app.use('/api/ai', requireAuth, aiRouter);
  app.use('/api/templates', requireAuth, templatesRouter);
  app.use('/api/github', requireAuth, githubRouter);

  app.use((_req, res) => {
    const body: ErrorResponse = { error: 'not_found', message: 'Route not found' };
    res.status(404).json(body);
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json(err.body);
      return;
    }
    const raw =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    const status = raw >= 400 && raw < 600 ? raw : 500;
    // Client errors (e.g. malformed JSON) get a generic message; nothing from the stack leaks.
    // Only the error itself is logged, never the request (which may hold a password).
    if (status >= 500) console.error('Unhandled error:', err instanceof Error ? err.stack : err);
    let body: ErrorResponse;
    if (status >= 500) body = { error: 'internal_error', message: 'Internal server error' };
    else if (status === 413)
      body = { error: 'payload_too_large', message: 'Request body too large' };
    else body = { error: 'bad_request', message: 'Bad request' };
    res.status(status).json(body);
  };
  app.use(errorHandler);

  return app;
}
