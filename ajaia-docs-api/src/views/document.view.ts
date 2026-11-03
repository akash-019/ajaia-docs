import type {
  DocumentRecord,
  DocumentSummaryRecord,
  SharedDocumentSummaryRecord,
} from '../models/document.model.js';
import type { Role } from '../services/access.service.js';

/** A document as the API returns it, including the caller's role. */
export function documentView(doc: DocumentRecord, role: Role) {
  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    version: doc.version,
    role,
    owner: { id: doc.ownerId, name: doc.ownerName, email: doc.ownerEmail },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** A short excerpt of the text around the first match, for search results. */
export function snippetAround(text: string, query: string): string | undefined {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return undefined;
  // Widen to whole words so the excerpt doesn't start or end mid-word.
  let start = Math.max(0, at - 60);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, at + query.length + 80);
  if (end < text.length) end = text.lastIndexOf(' ', end) > at + query.length ? text.lastIndexOf(' ', end) : end;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** The documents list: owned and shared, with a match snippet when searching. */
export function documentListView(owned: DocumentSummaryRecord[], shared: SharedDocumentSummaryRecord[], query: string) {
  const summary = <T extends DocumentSummaryRecord>({ text, ...doc }: T) => ({
    ...doc,
    ...(query ? { snippet: snippetAround(text ?? '', query) } : {}),
  });
  return { owned: owned.map(summary), shared: shared.map(summary) };
}
