import type { ShareRecord } from '../models/share.model.js';

/** Someone a document is shared with, and their role. */
export function shareView(share: ShareRecord) {
  return { userId: share.userId, email: share.email, name: share.name, role: share.role };
}
