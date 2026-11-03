import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist matching what the editor can produce. Everything stored goes through
 * this, whether it came from the editor or from an imported file.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's',
    'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'a',
  ],
  allowedAttributes: { a: ['href', 'target', 'rel'], ol: ['start'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Headings deeper than h3 are folded into h3 so imported docs stay within the editor's scale.
  transformTags: { h4: 'h3', h5: 'h3', h6: 'h3' },
};

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Plain text of a document, used for search. Block boundaries become spaces so words don't merge. */
export function toPlainText(html: string): string {
  const spaced = html.replace(/<\/(p|h[1-6]|li|blockquote|pre)>|<br\s*\/?>/gi, ' ');
  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}
