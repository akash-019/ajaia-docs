import { DatePipe } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import {
  Attachment,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_TYPES_LABEL,
  MAX_ATTACHMENT_MB,
  MAX_ATTACHMENTS_PER_DOCUMENT,
} from '../../core/models';

const ICONS: Record<string, string> = { 'application/pdf': '📕', 'application/zip': '🗜️', 'text/csv': '📊' };
const iconFor = (type: string) => ICONS[type] ?? (type.startsWith('image/') ? '🖼️' : type.startsWith('text/') ? '📝' : '📄');

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files attached to the document. The editor page owns the list and refreshes it on live updates. */
@Component({
  selector: 'app-attachments-panel',
  imports: [DatePipe],
  template: `
    <aside class="share-panel" aria-label="Attachments">
      <div class="panel-head">
        <h2>Attachments</h2>
        <button class="btn btn-ghost btn-sm" (click)="closed.emit()" aria-label="Close attachments panel">✕</button>
      </div>

      @if (canEdit()) {
        <label class="btn btn-primary btn-block attach-upload" [class.disabled]="busy()">
          {{ busy() ? 'Uploading…' : '+ Attach a file' }}
          <input type="file" hidden [accept]="accept" [disabled]="busy()" (change)="upload($event)" />
        </label>
        <p class="small muted">{{ typesLabel }} · up to {{ maxMb }} MB each, {{ maxCount }} per document.</p>
      } @else {
        <p class="small muted">View only: you can download attachments.</p>
      }

      @if (error()) {
        <p class="alert alert-error small" role="alert">{{ error() }}</p>
      }

      @if (attachments().length) {
        <ul class="attach-list">
          @for (a of attachments(); track a.id) {
            <li>
              <span class="attach-icon" aria-hidden="true">{{ icon(a.contentType) }}</span>
              <span class="grow">
                <a class="attach-name" [href]="url(a.id)" [attr.download]="a.filename" [title]="'Download ' + a.filename">
                  {{ a.filename }}
                </a>
                <span class="muted small block">
                  {{ size(a.size) }} · {{ a.uploadedBy.name }} · {{ a.createdAt | date: 'MMM d, h:mm a' }}
                </span>
              </span>
              @if (a.canDelete) {
                <button class="btn btn-ghost btn-sm" [disabled]="busy()" (click)="remove(a)" [attr.aria-label]="'Delete ' + a.filename">
                  Delete
                </button>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="empty small">No attachments yet.</p>
      }
    </aside>
  `,
})
export class AttachmentsPanel {
  private api = inject(ApiService);

  readonly docId = input.required<string>();
  readonly attachments = input.required<Attachment[]>();
  readonly canEdit = input.required<boolean>();
  readonly closed = output<void>();
  /** Emitted after this user uploads or deletes, so the editor reloads the list. */
  readonly changed = output<void>();

  protected readonly accept = ATTACHMENT_ACCEPT;
  protected readonly typesLabel = ATTACHMENT_TYPES_LABEL;
  protected readonly maxMb = MAX_ATTACHMENT_MB;
  protected readonly maxCount = MAX_ATTACHMENTS_PER_DOCUMENT;
  protected readonly icon = iconFor;
  protected readonly size = formatSize;
  protected busy = signal(false);
  protected error = signal('');

  protected url(attachmentId: string) {
    return this.api.attachmentUrl(this.docId(), attachmentId);
  }

  async upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow choosing the same file again
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
      this.error.set(`"${file.name}" is larger than ${MAX_ATTACHMENT_MB} MB.`);
      return;
    }
    await this.run(() => this.api.uploadAttachment(this.docId(), file));
  }

  async remove(attachment: Attachment) {
    if (!confirm(`Delete "${attachment.filename}"? Everyone with access loses it.`)) return;
    await this.run(() => this.api.deleteAttachment(this.docId(), attachment.id));
  }

  private async run(action: () => Promise<unknown>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      this.changed.emit();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
