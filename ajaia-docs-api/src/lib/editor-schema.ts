import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

/**
 * Must describe the same document schema as the editor in ajaia-docs-ui
 * (src/app/pages/editor/editor.page.ts). The server uses it to turn the
 * collaborative Yjs state into HTML and to seed Yjs state from stored HTML.
 */
export const editorExtensions = [StarterKit.configure({ heading: { levels: [1, 2, 3] }, undoRedo: false })];
export const editorSchema = getSchema(editorExtensions);

/** Name of the Yjs XML fragment the TipTap Collaboration extension binds to. */
export const YJS_FIELD = 'default';
