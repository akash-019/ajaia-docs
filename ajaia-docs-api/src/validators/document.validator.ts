import { z } from 'zod';

const title = z.string().trim().min(1, 'Title cannot be empty').max(200, 'Title is too long (max 200 characters)');

export const createDocumentBody = z.object({ title: title.optional() });

// Content is edited through the real-time channel (see collab.service.ts); REST only renames.
export const renameDocumentBody = z.object({ title });

export const shareBody = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  role: z.enum(['viewer', 'editor']).default('editor'),
});

/** `?q=` search text: trimmed and capped. */
export const searchQuery = (q: unknown) => (typeof q === 'string' ? q.trim().slice(0, 100) : '');
