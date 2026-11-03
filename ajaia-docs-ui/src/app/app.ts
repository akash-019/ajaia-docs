import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <header class="app-header">
      <a routerLink="/" class="brand"><span class="brand-mark">A</span> Ajaia Docs</a>
      @if (auth.user(); as user) {
        <div class="header-user">
          <span class="avatar" [title]="user.email">{{ user.name[0] }}</span>
          <span class="header-name">{{ user.name }}</span>
          <button class="btn btn-ghost" (click)="logout()">Sign out</button>
        </div>
      }
    </header>
    <main><router-outlet /></main>
  `,
})
export class App {
  protected auth = inject(AuthService);
  private router = inject(Router);

  async logout() {
    await this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
