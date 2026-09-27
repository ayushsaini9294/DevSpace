import type { ErrorResponse } from '@devspace/shared';

/**
 * An error that maps directly to an HTTP response. Throw it from a route (sync or async);
 * the app's error handler sends `status` with a body that matches ErrorResponseSchema.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: ErrorResponse;

  constructor(status: number, error: string, message: string, fields?: ErrorResponse['fields']) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = fields ? { error, message, fields } : { error, message };
  }
}
