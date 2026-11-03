import { Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { errorMessage } from '../core/api.service';
import { AuthService } from '../core/auth';

@Component({
  selector: 'app-login-page',
  template: `
    <section class="login">
      <h1>Sign in</h1>
      <p class="muted">Sign in to your Ajaia Docs account.</p>
      @if (reason() === 'expired') {
        <p class="alert alert-info" role="status">Your session expired. Please sign in again.</p>
      }

      <form class="login-form" (submit)="$event.preventDefault(); signIn(email.value, password.value)">
        <label class="field">
          <span class="small muted">Email</span>
          <input #email type="email" name="email" autocomplete="username" required autofocus />
        </label>
        <label class="field">
          <span class="small muted">Password</span>
          <input #password type="password" name="password" autocomplete="current-password" required />
        </label>
        @if (error()) {
          <p class="alert alert-error" role="alert">{{ error() }}</p>
        }
        <button class="btn btn-primary btn-block" [disabled]="busy()">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </section>
  `,
})
export class LoginPage {
  private auth = inject(AuthService);
  private router = inject(Router);

  /** Bound from the ?next= query param set by the auth guard. */
  readonly next = input<string>();
  /** `expired` when sent here because the session ended. */
  readonly reason = input<string>();
  protected busy = signal(false);
  protected error = signal('');

  async signIn(email: string, password: string) {
    if (!email.trim() || !password) {
      this.error.set('Enter your email and password.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(email.trim(), password);
      const next = this.next();
      // Only follow same-app relative paths.
      this.router.navigateByUrl(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
