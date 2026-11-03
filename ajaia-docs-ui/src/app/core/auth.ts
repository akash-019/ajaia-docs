import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, OnDestroy, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { ApiService } from './api.service';
import { SessionUser, User } from './models';

/** While the user is active, ping the API this often so the server slides the session forward. */
const KEEPALIVE_MS = 5 * 60 * 1000;
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/**
 * Session state on the client. The token itself lives in an httpOnly cookie that
 * scripts can't read; the server tells us when it expires (`expiresAt`).
 *
 * - Active users stay signed in: activity triggers a periodic keep-alive request,
 *   which renews the session server-side.
 * - Idle users are signed out when the session expires: a timer checks at that moment.
 * - Any 401 while signed in (see sessionInterceptor) sends the user to sign in again
 *   and back to the page they were on.
 */
@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);

  readonly user = signal<User | null>(null);
  private loaded: Promise<User | null> | null = null;
  private lastActivity = Date.now();
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly markActive = () => (this.lastActivity = Date.now());

  /** Resolves the session cookie once per page load. */
  ensureLoaded(): Promise<User | null> {
    this.loaded ??= this.api.me().then(
      (u) => (this.start(u), u),
      () => null,
    );
    return this.loaded;
  }

  async login(email: string, password: string) {
    const user = await this.api.login(email, password);
    this.start(user);
    this.loaded = Promise.resolve(user);
  }

  async logout() {
    try {
      await this.api.logout();
    } finally {
      this.clear();
    }
  }

  /** Called when the server no longer accepts the session. */
  sessionExpired() {
    if (!this.user()) return;
    const next = this.router.url;
    this.clear();
    this.router.navigate(['/login'], { queryParams: { reason: 'expired', ...(next.startsWith('/login') ? {} : { next }) } });
  }

  ngOnDestroy() {
    this.stopTimers();
  }

  private start(session: SessionUser) {
    const { expiresAt, ...user } = session;
    this.user.set(user);
    this.scheduleExpiryCheck(expiresAt);
    if (this.keepAlive) return;
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, this.markActive, { passive: true }));
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastActivity < KEEPALIVE_MS) void this.refresh();
    }, KEEPALIVE_MS);
  }

  private scheduleExpiryCheck(expiresAt: number) {
    clearTimeout(this.expiryTimer);
    // A second after expiry, ask the server. It may have been renewed meanwhile (another tab);
    // otherwise the 401 triggers sessionExpired().
    const delay = Math.min(expiresAt * 1000 - Date.now() + 1000, 2 ** 31 - 1);
    this.expiryTimer = setTimeout(() => void this.refresh(), Math.max(delay, 0));
  }

  private async refresh() {
    try {
      const session = await this.api.me();
      this.scheduleExpiryCheck(session.expiresAt);
    } catch {
      // 401 is handled by the interceptor; network errors are retried on the next tick.
    }
  }

  private clear() {
    this.stopTimers();
    this.user.set(null);
    this.loaded = Promise.resolve(null);
  }

  private stopTimers() {
    clearInterval(this.keepAlive);
    clearTimeout(this.expiryTimer);
    this.keepAlive = undefined;
    ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, this.markActive));
  }
}

/** Sends the user to sign in when a request fails because the session ended. */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.endsWith('/api/auth/login')) {
        auth.sessionExpired();
      }
      return throwError(() => err);
    }),
  );
};

export const authGuard: CanActivateFn = async (_route, state) => {
  // inject() must run before the first await, while the injection context is still active.
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.ensureLoaded();
  return user ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};
