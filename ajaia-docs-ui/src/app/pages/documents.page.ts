import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ApiService, errorMessage } from '../core/api.service';
import { DocumentList, DocumentSummary, MAX_UPLOAD_MB, SUPPORTED_IMPORT_TYPES } from '../core/models';

const SEARCH_DEBOUNCE_MS = 250;

@Component({
  selector: 'app-documents-page',
  imports: [RouterLink, DatePipe, NgTemplateOutlet],
  template: `
    <section class="page">
      <div class="page-head">
        <h1>Documents</h1>
        <div class="actions">
          <button class="btn btn-primary" [disabled]="busy()" (click)="create()">+ New document</button>
          <label class="btn" [class.disabled]="busy()">
            Import file
            <input type="file" hidden [accept]="acceptTypes" [disabled]="busy()" (change)="import($event)" />
          </label>
        </div>
      </div>
      <p class="muted small">
        Import turns a <strong>.txt</strong>, <strong>.md</strong> or <strong>.docx</strong> file (max
        {{ maxMb }} MB) into a new editable document. Images and complex layout are not imported.
      </p>

      <div class="search" role="search">
        <span class="search-icon" aria-hidden="true">🔍</span>
        <input
          #search
          type="search"
          placeholder="Search titles and text"
          aria-label="Search documents"
          maxlength="100"
          [value]="query()"
          (input)="onSearch(search.value)"
          (keydown.escape)="onSearch(''); search.value = ''"
        />
        @if (query()) {
          <button class="btn btn-ghost btn-sm search-clear" (click)="onSearch(''); search.value = ''" aria-label="Clear search">✕</button>
        }
      </div>

      @if (error()) {
        <p class="alert alert-error" role="alert">{{ error() }}</p>
      }

      @if (docs(); as docs) {
        @if (query() && !docs.owned.length && !docs.shared.length) {
          <p class="empty">No documents match "{{ query() }}".</p>
        } @else {
        <h2 class="section-title">My documents <span class="count">{{ docs.owned.length }}</span></h2>
        @if (docs.owned.length) {
          <ul class="doc-list">
            @for (doc of docs.owned; track doc.id) {
              <li class="doc-row">
                <a [routerLink]="['/docs', doc.id]" class="doc-link">
                  <span class="doc-icon" aria-hidden="true">📄</span>
                  <ng-container *ngTemplateOutlet="docText; context: { $implicit: doc }" />
                </a>
                <span class="muted small">Edited {{ doc.updatedAt | date: 'MMM d, h:mm a' }}</span>
                <button class="btn btn-ghost btn-sm" (click)="remove(doc)" [disabled]="busy()">Delete</button>
              </li>
            }
          </ul>
        } @else {
          <p class="empty">{{ query() ? 'No matches in your documents.' : 'No documents yet. Create one or import a file to get started.' }}</p>
        }

        <h2 class="section-title">Shared with me <span class="count">{{ docs.shared.length }}</span></h2>
        @if (docs.shared.length) {
          <ul class="doc-list">
            @for (doc of docs.shared; track doc.id) {
              <li class="doc-row">
                <a [routerLink]="['/docs', doc.id]" class="doc-link">
                  <span class="doc-icon" aria-hidden="true">👥</span>
                  <ng-container *ngTemplateOutlet="docText; context: { $implicit: doc }" />
                </a>
                <span class="muted small">Owned by {{ doc.ownerName }}</span>
                <span class="badge" [class.badge-view]="doc.role === 'viewer'">
                  {{ doc.role === 'editor' ? 'Can edit' : 'View only' }}
                </span>
              </li>
            }
          </ul>
        } @else {
          <p class="empty">{{ query() ? 'No matches in documents shared with you.' : 'Nothing shared with you yet.' }}</p>
        }
        }
      } @else if (!error()) {
        <p class="muted">Loading…</p>
      }
    </section>

    <!-- Title (and match snippet when searching) with the query highlighted. -->
    <ng-template #docText let-doc>
      <span class="doc-main">
        <span class="doc-title">
          @for (part of highlight(doc.title); track $index) {
            @if (part.match) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} }
          }
        </span>
        @if (doc.snippet) {
          <span class="snippet">
            @for (part of highlight(doc.snippet); track $index) {
              @if (part.match) { <mark>{{ part.text }}</mark> } @else { {{ part.text }} }
            }
          </span>
        }
      </span>
    </ng-template>
  `,
})
export class DocumentsPage implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);

  protected readonly acceptTypes = SUPPORTED_IMPORT_TYPES;
  protected readonly maxMb = MAX_UPLOAD_MB;
  protected docs = signal<DocumentList | null>(null);
  protected query = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ignores responses to searches that were superseded while in flight. */
  private requestId = 0;
  protected busy = signal(false);
  protected error = signal('');

  ngOnInit() {
    this.load();
  }

  ngOnDestroy() {
    clearTimeout(this.searchTimer);
  }

  async load() {
    const id = ++this.requestId;
    try {
      const docs = await this.api.listDocuments(this.query());
      if (id === this.requestId) this.docs.set(docs);
    } catch (err) {
      if (id === this.requestId) this.error.set(errorMessage(err));
    }
  }

  onSearch(value: string) {
    this.query.set(value.trim());
    this.error.set('');
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(), value.trim() ? SEARCH_DEBOUNCE_MS : 0);
  }

  /** Splits text into plain and matching parts so matches render as <mark> without innerHTML. */
  protected highlight(text: string): { text: string; match: boolean }[] {
    const q = this.query();
    if (!q) return [{ text, match: false }];
    const parts: { text: string; match: boolean }[] = [];
    const lower = text.toLowerCase();
    const needle = q.toLowerCase();
    let from = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
      if (at > from) parts.push({ text: text.slice(from, at), match: false });
      parts.push({ text: text.slice(at, at + q.length), match: true });
      from = at + q.length;
    }
    if (from < text.length) parts.push({ text: text.slice(from), match: false });
    return parts;
  }

  create() {
    return this.run(async () => {
      const doc = await this.api.createDocument();
      this.router.navigate(['/docs', doc.id]);
    });
  }

  import(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file after an error
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      this.error.set(`"${file.name}" is larger than ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    return this.run(async () => {
      const doc = await this.api.importDocument(file);
      this.router.navigate(['/docs', doc.id]);
    });
  }

  remove(doc: DocumentSummary) {
    if (!confirm(`Delete "${doc.title}"? This also removes access for everyone it is shared with.`)) return;
    return this.run(async () => {
      await this.api.deleteDocument(doc.id);
      await this.load();
    });
  }

  private async run(action: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
