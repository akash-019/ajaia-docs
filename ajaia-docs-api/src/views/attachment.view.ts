import type { AttachmentRecord } from '../models/attachment.model.js';

/** An attachment as listed by the API, with whether the caller may delete it. */
export function attachmentView(a: AttachmentRecord, canDelete: boolean) {
  return {
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    uploadedBy: { id: a.uploaderId, name: a.uploaderName },
    createdAt: a.createdAt,
    canDelete,
  };
}
