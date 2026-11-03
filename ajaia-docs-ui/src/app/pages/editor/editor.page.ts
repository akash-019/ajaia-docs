import { HttpErrorResponse } from '@angular/common/http';
import {
  AfterViewInit,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import StarterKit from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { ApiService, errorMessage } from '../../core/api.service';
import { AuthService } from '../../core/auth';
import { Attachment, DocumentDetail, MAX_UPLOAD_MB, Role, SUPPORTED_IMPORT_TYPES } from '../../core/models';
import { AttachmentsPanel } from './attachments-panel';
import { SharePanel } from './share-panel';

/** Pushed by the server over the collaboration socket (see ajaia-docs-api/src/services/collab.service.ts). */
type CollabEvent =
  | { type: 'title'; title: string }
  | { type: 'access'; role: Role }
  | { type: 'revoked' }
  | { type: 'deleted' }
  | { type: 'session-ended' }
  | { type: 'attachments' };

interface Peer {
  id: string;
  name: string;
  color: string;
}

const PEER_COLORS = ['#e8590c', '#2f9e44', '#7048e8', '#d6336c', '#1971c2', '#0c8599', '#f08c00'];

function colorFor(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length];
}

/** Filename from a Content-Disposition header, preferring the UTF-8 form. */
function filenameFrom(disposition: string | null): string | null {
  const utf8 = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1]);
  return disposition?.match(/filename="([^"]+)"/i)?.[1] ?? null;
}

const collabUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/collab`;

/** Toolbar buttons: label, accessible name, active check and command. */
const TOOLS = [
  { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', active: (e: Editor) => e.isActive('bold'), run: (e: Editor) => e.chain().focus().toggleBold().run() },
  { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', active: (e: Editor) => e.isActive('italic'), run: (e: Editor) => e.chain().focus().toggleItalic().run() },
  { id: 'underline', label: 'U', title: 'Underline (Ctrl+U)', active: (e: Editor) => e.isActive('underline'), run: (e: Editor) => e.chain().focus().toggleUnderline().run() },
  { id: 'sep1' },
  { id: 'p', label: 'Text', title: 'Normal text', active: (e: Editor) => e.isActive('paragraph'), run: (e: Editor) => e.chain().focus().setParagraph().run() },
  { id: 'h1', label: 'H1', title: 'Heading 1', active: (e: Editor) => e.isActive('heading', { level: 1 }), run: (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: 'h2', label: 'H2', title: 'Heading 2', active: (e: Editor) => e.isActive('heading', { level: 2 }), run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: 'h3', label: 'H3', title: 'Heading 3', active: (e: Editor) => e.isActive('heading', { level: 3 }), run: (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: 'sep2' },
  { id: 'ul', label: '• List', title: 'Bulleted list', active: (e: Editor) => e.isActive('bulletList'), run: (e: Editor) => e.chain().focus().toggleBulletList().run() },
  { id: 'ol', label: '1. List', title: 'Numbered list', active: (e: Editor) => e.isActive('orderedList'), run: (e: Editor) => e.chain().focus().toggleOrderedList().run() },
  { id: 'quote', label: '❝', title: 'Quote', active: (e: Editor) => e.isActive('blockquote'), run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
  { id: 'sep3' },
  { id: 'undo', label: '↶', title: 'Undo your last change (Ctrl+Z)', active: () => false, run: (e: Editor) => e.chain().focus().undo().run() },
  { id: 'redo', label: '↷', title: 'Redo (Ctrl+Shift+Z)', active: () => false, run: (e: Editor) => e.chain().focus().redo().run() },
] as const;

/**
 * Live co-editing: the document is a Yjs CRDT synced through the API's collaboration
 * socket, so everyone with the document open sees changes as they are typed and
 * concurrent edits merge. The server decides who may write; this page mirrors it.
 */
@Component({
  selector: 'app-editor-page',
  imports: [RouterLink, SharePanel, AttachmentsPanel],
  templateUrl: './editor.page.html',
})
export class EditorPage implements AfterViewInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private pageTitle = inject(Title);

  /** Route param, bound via withComponentInputBinding. */
  readonly id = input.required<string>();
  private host = viewChild.required<ElementRef<HTMLElement>>('editorHost');

  protected readonly tools = TOOLS;
  protected readonly acceptTypes = SUPPORTED_IMPORT_TYPES;
  protected readonly maxMb = MAX_UPLOAD_MB;
  protected inserting = signal(false);
  protected doc = signal<DocumentDetail | null>(null);
  protected role = signal<Role | null>(null);
  protected loadError = signal('');
  /** Set when the session ends because access was removed or the document was deleted. */
  protected ended = signal('');
  protected notice = signal('');
  protected connection = signal<WebSocketStatus>(WebSocketStatus.Connecting);
  protected synced = signal(false);
  protected unsynced = signal(0);
  protected peers = signal<Peer[]>([]);
  protected titleDraft = signal('');
  protected titleError = signal('');
  protected shareOpen = signal(false);
  protected attachmentsOpen = signal(false);
  protected attachments = signal<Attachment[]>([]);
  protected exportOpen = signal(false);
  /** Bumped on every editor transaction so toolbar active states re-render. */
  private tick = signal(0);

  protected canEdit = computed(() => !this.ended() && (this.role() === 'owner' || this.role() === 'editor'));
  protected activeTools = computed(() => {
    this.tick();
    const editor = this.editor;
    return new Set(editor ? TOOLS.filter((t) => 'active' in t && t.active(editor)).map((t) => t.id) : []);
  });
  protected status = computed(() => {
    if (!this.synced()) return { text: 'Connecting…', tone: 'muted' };
    if (this.connection() !== WebSocketStatus.Connected) {
      return { text: this.canEdit() ? 'Offline: edits will sync when reconnected' : 'Reconnecting…', tone: 'warn' };
    }
    if (this.unsynced() > 0) return { text: 'Saving…', tone: 'muted' };
    return { text: this.canEdit() ? 'All changes saved' : 'Live', tone: 'ok' };
  });

  private editor: Editor | null = null;
  private provider: HocuspocusProvider | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  async ngAfterViewInit() {
    let doc: DocumentDetail;
    try {
      doc = await this.api.getDocument(this.id());
    } catch (err) {
      this.loadError.set(
        err instanceof HttpErrorResponse && err.status === 404
          ? 'This document does not exist or has not been shared with you.'
          : errorMessage(err),
      );
      return;
    }
    this.doc.set(doc);
    this.role.set(doc.role);
    this.setTitle(doc.title);
    void this.loadAttachments();

    this.startSession(doc);
  }

  /**
   * Connects the live-editing session: a fresh Yjs document synced from the server,
   * bound to a new editor. Restarted when the user's role changes (see onEvent).
   */
  private startSession(doc: DocumentDetail) {
    const me = this.auth.user()!;
    const ydoc = new Y.Doc();
    this.provider = new HocuspocusProvider({
      url: collabUrl(),
      name: doc.id,
      document: ydoc,
      // The session cookie authenticates the user; the token names the document instance this
      // tab holds, so a stale copy is refused if the server's document was re-created.
      token: doc.createdAt,
      onStatus: ({ status }) => this.connection.set(status),
      onSynced: ({ state }) => state && this.synced.set(true),
      onUnsyncedChanges: ({ number }) => this.unsynced.set(number),
      onAuthenticated: ({ scope }) => this.editor?.setEditable(scope === 'read-write' && this.canEdit()),
      onAuthenticationFailed: () => void this.recoverOrEnd(),
      onStateless: ({ payload }) => this.onEvent(JSON.parse(payload) as CollabEvent),
      onAwarenessChange: ({ states }) => {
        const seen = new Map<string, Peer>();
        for (const s of states) {
          const user = s['user'] as Peer | undefined;
          if (user?.id && user.id !== me.id) seen.set(user.id, user);
        }
        this.peers.set([...seen.values()]);
      },
    });

    this.editor = new Editor({
      element: this.host().nativeElement,
      extensions: [
        // Schema must match ajaia-docs-api/src/lib/editor-schema.ts.
        // trailingNode is off: it appends a paragraph on load, which would turn merely
        // opening a document into an edit (and, for viewers, a local change the server drops).
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          undoRedo: false,
          trailingNode: false,
          link: { openOnClick: false },
        }),
        Collaboration.configure({ document: ydoc }),
        CollaborationCaret.configure({
          provider: this.provider,
          user: { id: me.id, name: me.name, color: colorFor(me.id) },
        }),
      ],
      editable: this.canEdit(),
      editorProps: { attributes: { class: 'doc-body', spellcheck: 'true', 'aria-label': 'Document content' } },
      onTransaction: () => this.tick.update((n) => n + 1),
    });
  }

  /**
   * The server refused the live session. If the document itself was re-created (for example the
   * database was reset on redeploy), drop this tab's stale copy and load the current one;
   * otherwise access was removed.
   */
  private async recoverOrEnd() {
    const held = this.doc();
    if (!held || this.ended()) return;
    try {
      const current = await this.api.getDocument(held.id);
      if (current.createdAt !== held.createdAt) {
        this.doc.set(current);
        this.role.set(current.role);
        this.setTitle(current.title);
        void this.loadAttachments();
        setTimeout(() => {
          this.stopSession();
          this.startSession(current);
        });
        this.flash('This document was reset on the server. Showing the current version.');
        return;
      }
    } catch {
      // 404: no access any more (401 is handled by the session interceptor).
    }
    this.end('You no longer have access to this document.');
  }

  private stopSession() {
    this.provider?.destroy();
    this.editor?.destroy();
    this.provider = null;
    this.editor = null;
    this.host().nativeElement.replaceChildren();
    this.synced.set(false);
    this.unsynced.set(0);
    this.peers.set([]);
  }

  ngOnDestroy() {
    clearTimeout(this.noticeTimer);
    this.provider?.destroy();
    this.editor?.destroy();
  }

  @HostListener('window:beforeunload', ['$event'])
  warnOnUnsaved(event: BeforeUnloadEvent) {
    if (this.unsynced() > 0) event.preventDefault();
  }

  @HostListener('document:click', ['$event'])
  closeMenus(event: MouseEvent) {
    if (!(event.target as Element | null)?.closest('.menu')) this.exportOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  closeMenusOnEscape() {
    this.exportOpen.set(false);
  }

  protected async downloadMarkdown() {
    const doc = this.doc();
    if (!doc) return;
    this.exportOpen.set(false);
    try {
      const res = await this.api.exportMarkdown(doc.id);
      const url = URL.createObjectURL(res.body!);
      const link = document.createElement('a');
      link.href = url;
      link.download = filenameFrom(res.headers.get('content-disposition')) ?? `${doc.title}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      this.flash(`Export failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Inserts a .txt/.md/.docx file's content at the cursor. The server converts and
   * sanitizes it; inserting through the editor makes it a normal live edit for everyone.
   */
  protected async insertFromFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    const doc = this.doc();
    if (!file || !doc || !this.editor) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      this.flash(`"${file.name}" is larger than ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    this.inserting.set(true);
    try {
      const { html } = await this.api.convertForInsert(doc.id, file);
      this.editor.chain().focus().insertContent(html).run();
      this.flash(`Inserted the content of "${file.name}".`);
    } catch (err) {
      this.flash(`Could not insert "${file.name}": ${errorMessage(err)}`);
    } finally {
      this.inserting.set(false);
    }
  }

  /** One side panel at a time. */
  protected togglePanel(panel: 'share' | 'attachments') {
    const share = panel === 'share' && !this.shareOpen();
    const attachments = panel === 'attachments' && !this.attachmentsOpen();
    this.shareOpen.set(share);
    this.attachmentsOpen.set(attachments);
  }

  protected async loadAttachments() {
    const doc = this.doc();
    if (!doc) return;
    try {
      this.attachments.set(await this.api.listAttachments(doc.id));
    } catch {
      // Access problems surface elsewhere (session expiry, revocation events).
    }
  }

  /** PDF via the browser's print dialog ("Save as PDF"); the print stylesheet shows only the page. */
  protected printPdf() {
    this.exportOpen.set(false);
    setTimeout(() => window.print());
  }

  protected runTool(tool: (typeof TOOLS)[number]) {
    if (this.editor && 'run' in tool) tool.run(this.editor);
  }

  /** Select the whole title on focus so "Untitled document" can be typed over. */
  protected selectTitle(input: HTMLInputElement) {
    // Deferred: the click's mouseup would otherwise collapse the selection.
    if (this.canEdit()) setTimeout(() => input.select());
  }

  protected async commitTitle(input: HTMLInputElement) {
    const doc = this.doc();
    if (!doc || !this.canEdit()) return;
    const next = input.value.trim();
    if (next === doc.title) return;
    if (!next) {
      this.titleError.set('Title cannot be empty');
      input.value = doc.title;
      return;
    }
    this.titleError.set('');
    try {
      const saved = await this.api.updateDocument(doc.id, { title: next });
      this.doc.update((d) => d && { ...d, title: saved.title });
      this.setTitle(saved.title);
    } catch (err) {
      this.titleError.set(errorMessage(err));
      input.value = doc.title;
    }
  }

  private onEvent(event: CollabEvent) {
    switch (event.type) {
      case 'title':
        this.doc.update((d) => d && { ...d, title: event.title });
        this.setTitle(event.title);
        break;
      case 'attachments':
        void this.loadAttachments();
        break;
      case 'access': {
        const couldEdit = this.canEdit();
        this.role.set(event.role);
        void this.loadAttachments(); // delete permissions depend on the role
        // Switching between viewing and editing restarts the live session from the server's
        // copy, so nothing this browser held locally can block or leak into later edits.
        // Deferred: this runs inside the connection's own message callback.
        if (couldEdit !== this.canEdit() && this.doc()) {
          const doc = this.doc()!;
          setTimeout(() => {
            if (this.ended()) return;
            this.stopSession();
            this.startSession(doc);
          });
        }
        this.flash(event.role === 'editor' ? 'You can now edit this document.' : 'Your access changed to view only.');
        break;
      }
      case 'revoked':
        this.end('The owner removed your access to this document.');
        break;
      case 'deleted':
        this.end('The owner deleted this document.');
        break;
      case 'session-ended':
        this.provider?.destroy();
        this.auth.sessionExpired();
        break;
    }
  }

  private end(message: string) {
    this.ended.set(message);
    this.shareOpen.set(false);
    this.attachmentsOpen.set(false);
    this.provider?.destroy();
    this.editor?.setEditable(false);
  }

  private setTitle(title: string) {
    // Don't clobber a rename the user is typing right now.
    if (document.activeElement?.classList.contains('title-input')) return;
    this.titleDraft.set(title);
    this.pageTitle.setTitle(`${title} · Ajaia Docs`);
  }

  private flash(message: string) {
    this.notice.set(message);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(''), 4000);
  }
}
