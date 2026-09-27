import express, { type ErrorRequestHandler, type Express } from 'express';
import { healthRouter } from './routes/health.ts';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Route not found' });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;
    // Client errors (e.g. malformed JSON) get a generic message; nothing from the stack leaks.
    if (status >= 500) console.error('Unhandled error:', err);
    res
      .status(status)
      .json(
        status >= 500
          ? { error: 'internal_error', message: 'Internal server error' }
          : { error: 'bad_request', message: 'Bad request' },
      );
  };
  app.use(errorHandler);

  return app;
}
