import type { RequestHandler } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/http-error.js';
import { MAX_ATTACHMENT_BYTES } from '../services/attachment.service.js';
import { MAX_UPLOAD_BYTES } from '../services/import.service.js';

/** One file in the "file" field, kept in memory, with a size limit that reports itself in MB. */
function singleFileUpload(maxBytes: number): RequestHandler {
  const handler = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 } }).single('file');
  return (req, res, next) =>
    handler(req, res, (err?: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(400, `File is too large (max ${maxBytes / 1024 / 1024} MB)`));
      }
      next(err);
    });
}

/** Files converted into document content (.txt/.md/.docx). */
export const importUpload = singleFileUpload(MAX_UPLOAD_BYTES);

/** Files attached to a document. */
export const attachmentUpload = singleFileUpload(MAX_ATTACHMENT_BYTES);
