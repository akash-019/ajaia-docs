import { Routes } from '@angular/router';
import { authGuard } from './core/auth';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login.page').then((m) => m.LoginPage), title: 'Sign in · Ajaia Docs' },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/documents.page').then((m) => m.DocumentsPage),
    title: 'Documents · Ajaia Docs',
  },
  {
    path: 'docs/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/editor/editor.page').then((m) => m.EditorPage),
  },
  { path: '**', redirectTo: '' },
];
