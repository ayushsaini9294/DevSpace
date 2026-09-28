import type { ErrorResponse } from '@devspace/shared';

/**
 * An error that maps directly to an HTTP response. Throw it from a route (sync or async);
 * the app's error handler sends `status` with a body that matches ErrorResponseSchema.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: ErrorResponse;

  constructor(
    status: number,
    error: string,
    message: string,
    fields?: ErrorResponse['fields'],
    details?: ErrorResponse['details'],
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = { error, message };
    if (fields) this.body.fields = fields;
    if (details) this.body.details = details;
  }
}
