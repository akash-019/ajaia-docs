export interface User {
  id: string;
  email: string;
  name: string;
}

/** Signed-in user plus when the session expires (Unix seconds). */
export interface SessionUser extends User {
  expiresAt: number;
}

export type Role = 'owner' | 'editor' | 'viewer';
export type ShareRole = Exclude<Role, 'owner'>;

export interface DocumentSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** Text around the match, present on search results. */
  snippet?: string;
}

export interface SharedDocumentSummary extends DocumentSummary {
  role: ShareRole;
  ownerName: string;
}

export interface DocumentList {
  owned: DocumentSummary[];
  shared: SharedDocumentSummary[];
}

export interface DocumentDetail {
  id: string;
  title: string;
  content: string;
  version: number;
  role: Role;
  owner: User;
  createdAt: string;
  updatedAt: string;
}

export interface Share {
  userId: string;
  email: string;
  name: string;
  role: ShareRole;
}

export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: { id: string; name: string };
  createdAt: string;
  /** Whether the current user may delete it (owner: any; editor: their own). */
  canDelete: boolean;
}

/** Must match ajaia-docs-api/src/services/attachment.service.ts. */
export const ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.pptx,.txt,.md,.csv,.zip';
export const ATTACHMENT_TYPES_LABEL = 'PDF, images (PNG, JPG, GIF, WebP), Word, Excel, PowerPoint, TXT, MD, CSV, ZIP';
export const MAX_ATTACHMENT_MB = 5;
export const MAX_ATTACHMENTS_PER_DOCUMENT = 10;

export const SUPPORTED_IMPORT_TYPES = '.txt,.md,.docx';
export const MAX_UPLOAD_MB = 2;
