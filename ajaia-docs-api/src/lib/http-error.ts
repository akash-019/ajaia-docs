/** An error with an HTTP status; the error middleware turns it into `{ error, details }` JSON. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Documents the caller can't access are reported as missing, not forbidden, so private ids aren't confirmed. */
export const documentNotFound = () => new HttpError(404, 'Document not found');
