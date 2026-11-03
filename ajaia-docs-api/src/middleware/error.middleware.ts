import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { HttpError } from '../lib/http-error.js';

/** Unknown /api/* paths. */
export const apiNotFound: RequestHandler = () => {
  throw new HttpError(404, 'Not found');
};

/** Every error becomes `{ error, details? }` JSON with a fitting status; internals are only logged. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: err.issues.map((i) => i.message) });
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB)' : err.message;
    res.status(400).json({ error: message });
    return;
  }
  // Client errors raised by Express middleware (malformed JSON, body too large, ...).
  if (err?.expose && typeof err.status === 'number' && err.status < 500) {
    res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Malformed JSON body' : err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
};
