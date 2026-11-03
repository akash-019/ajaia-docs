import path from 'node:path';
import mammoth from 'mammoth';
import { marked } from 'marked';
import { HttpError } from './errors.js';
import { sanitizeContent } from './sanitize.js';

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx'] as const;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Blank lines separate paragraphs; single newlines become line breaks. */
function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function titleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename)).trim();
  return (base || 'Imported document').slice(0, 200);
}

/** Converts an uploaded file into sanitized editor HTML. Throws 400 for unsupported or unreadable files. */
export async function fileToHtml(filename: string, buffer: Buffer): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  let html: string;
  switch (ext) {
    case '.txt':
      html = textToHtml(buffer.toString('utf8'));
      break;
    case '.md':
      html = await marked.parse(buffer.toString('utf8'));
      break;
    case '.docx':
      try {
        html = (await mammoth.convertToHtml({ buffer })).value;
      } catch {
        throw new HttpError(400, 'Could not read this .docx file. Is it a valid Word document?');
      }
      break;
    default:
      throw new HttpError(400, `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  return sanitizeContent(html);
}
