import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});

// Markdown has no underline; inline HTML is valid Markdown and our importer reads it back.
turndown.addRule('underline', {
  filter: ['u'],
  replacement: (content) => (content ? `<u>${content}</u>` : ''),
});

// Compact list items ("- item", "1. item") instead of turndown's padded default.
turndown.addRule('listItem', {
  filter: 'li',
  replacement: (content, node) => {
    const parent = node.parentNode as HTMLElement | null;
    let marker = '- ';
    if (parent?.nodeName === 'OL') {
      const start = Number(parent.getAttribute('start') ?? 1);
      marker = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
    }
    const body = content
      .replace(/^\n+/, '')
      .replace(/\n+$/, '')
      .replace(/\n\s*\n/g, '\n') // keep nested lists tight
      .replace(/\n/g, `\n${' '.repeat(marker.length)}`);
    return `${marker}${body}${node.nextSibling ? '\n' : ''}`;
  },
});

/**
 * Converts stored editor HTML to Markdown. The editor wraps list item text in <p>;
 * unwrapping single-paragraph items keeps lists tight instead of "loose".
 */
export function htmlToMarkdown(html: string): string {
  const tight = html.replace(/<li><p>((?:(?!<\/?p>).)*)<\/p><\/li>/g, '<li>$1</li>');
  return `${turndown.turndown(tight).trim()}\n`;
}

/** A safe download filename from a document title. */
export function exportFilename(title: string, extension: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${base || 'document'}.${extension}`;
}
