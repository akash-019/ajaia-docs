import path from 'node:path';
import { HttpError } from '../lib/http-error.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_DOCUMENT = 10;

/**
 * Allowed attachment types, by extension. The stored content type comes from this table,
 * never from the uploader's claim. HTML and SVG are deliberately absent: they can carry script.
 */
export const ATTACHMENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

const SUPPORTED = Object.keys(ATTACHMENT_TYPES).join(', ');

/** Strips any path and control characters, keeps a sane length. */
export function cleanFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'attachment').slice(0, 200);
}

/** Checks an upload against the policy and returns its stored content type. */
export function checkAttachment(filename: string, size: number, existingCount: number): string {
  const contentType = ATTACHMENT_TYPES[path.extname(filename).toLowerCase()];
  if (!contentType) throw new HttpError(400, `This file type can't be attached. Supported: ${SUPPORTED}`);
  if (size === 0) throw new HttpError(400, 'That file is empty');
  if (existingCount >= MAX_ATTACHMENTS_PER_DOCUMENT) {
    throw new HttpError(400, `A document can have at most ${MAX_ATTACHMENTS_PER_DOCUMENT} attachments`);
  }
  return contentType;
}
