import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import { ApiService, errorMessage } from '../../core/api.service';
import { DocumentDetail, Share, ShareRole, User } from '../../core/models';

/** Owner manages access; everyone else sees who has access. */
@Component({
  selector: 'app-share-panel',
  template: `
    <aside class="share-panel" aria-label="Sharing">
      <div class="panel-head">
        <h2>{{ isOwner() ? 'Share document' : 'People with access' }}</h2>
        <button class="btn btn-ghost btn-sm" (click)="closed.emit()" aria-label="Close sharing panel">✕</button>
      </div>

      @if (isOwner()) {
        <form class="share-form" (submit)="$event.preventDefault(); submit(email, role)">
          <label class="field">
            <span class="small muted">Email</span>
            <input #email list="share-candidates" type="email" required placeholder="name@ajaia.dev" />
            <datalist id="share-candidates">
              @for (u of candidates(); track u.id) {
                <option [value]="u.email">{{ u.name }}</option>
              }
            </datalist>
          </label>
          <label class="field">
            <span class="small muted">Access</span>
            <select #role>
              <option value="editor">Can edit</option>
              <option value="viewer">View only</option>
            </select>
          </label>
          <button class="btn btn-primary" [disabled]="busy()">Share</button>
        </form>
        @if (candidates().length) {
          <p class="small muted">Demo users: {{ candidateEmails() }}</p>
        }
      }

      @if (error()) {
        <p class="alert alert-error small" role="alert">{{ error() }}</p>
      }

      <ul class="people">
        <li>
          <span class="avatar">{{ doc().owner.name[0] }}</span>
          <span class="grow">{{ doc().owner.name }}<span class="muted small block">{{ doc().owner.email }}</span></span>
          <span class="small muted">Owner</span>
        </li>
        @for (s of shares(); track s.userId) {
          <li>
            <span class="avatar">{{ s.name[0] }}</span>
            <span class="grow">{{ s.name }}<span class="muted small block">{{ s.email }}</span></span>
            @if (isOwner()) {
              <select
                [disabled]="busy()"
                [attr.aria-label]="'Access for ' + s.name"
                (change)="add(s.email, $any($event.target).value)"
              >
                <option value="editor" [selected]="s.role === 'editor'">Can edit</option>
                <option value="viewer" [selected]="s.role === 'viewer'">View only</option>
              </select>
              <button class="btn btn-ghost btn-sm" [disabled]="busy()" (click)="remove(s)">Remove</button>
            } @else {
              <span class="small muted">{{ s.role === 'editor' ? 'Can edit' : 'View only' }}</span>
            }
          </li>
        }
      </ul>
    </aside>
  `,
})
export class SharePanel implements OnInit {
  private api = inject(ApiService);

  readonly doc = input.required<DocumentDetail>();
  readonly closed = output<void>();

  protected shares = signal<Share[]>([]);
  private users = signal<User[]>([]);
  protected busy = signal(false);
  protected error = signal('');

  protected isOwner = computed(() => this.doc().role === 'owner');
  protected candidates = computed(() => {
    const taken = new Set([this.doc().owner.id, ...this.shares().map((s) => s.userId)]);
    return this.users().filter((u) => !taken.has(u.id));
  });
  protected candidateEmails = computed(() => this.candidates().map((u) => u.email).join(', '));

  async ngOnInit() {
    try {
      const [shares, users] = await Promise.all([this.api.listShares(this.doc().id), this.api.users()]);
      this.shares.set(shares);
      this.users.set(users);
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }

  async submit(email: HTMLInputElement, role: HTMLSelectElement) {
    if (await this.add(email.value, role.value)) email.value = '';
  }

  async add(email: string, role: string): Promise<boolean> {
    if (!email.trim()) return false;
    return this.run(async () => {
      await this.api.share(this.doc().id, email.trim(), role as ShareRole);
      this.shares.set(await this.api.listShares(this.doc().id));
    });
  }

  async remove(share: Share) {
    await this.run(async () => {
      await this.api.unshare(this.doc().id, share.userId);
      this.shares.update((list) => list.filter((s) => s.userId !== share.userId));
    });
  }

  private async run(action: () => Promise<void>): Promise<boolean> {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      return true;
    } catch (err) {
      this.error.set(errorMessage(err));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
