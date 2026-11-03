import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Attachment, DocumentDetail, DocumentList, SessionUser, Share, ShareRole, User } from './models';

/** Pulls the server's `{ error }` message out of an HTTP failure for display. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Check your connection.';
    return err.error?.error ?? `Request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  users() {
    return firstValueFrom(this.http.get<User[]>('/api/users'));
  }
  me() {
    return firstValueFrom(this.http.get<SessionUser>('/api/auth/me'));
  }
  login(email: string, password: string) {
    return firstValueFrom(this.http.post<SessionUser>('/api/auth/login', { email, password }));
  }
  logout() {
    return firstValueFrom(this.http.post<void>('/api/auth/logout', {}));
  }

  listDocuments(query = '') {
    const params = query ? { q: query } : undefined;
    return firstValueFrom(this.http.get<DocumentList>('/api/documents', { params }));
  }
  createDocument(title?: string) {
    return firstValueFrom(this.http.post<DocumentDetail>('/api/documents', { title }));
  }
  importDocument(file: File) {
    const form = new FormData();
    form.append('file', file);
    return firstValueFrom(this.http.post<DocumentDetail>('/api/documents/import', form));
  }
  /** Converts a file for insertion into an existing document (the editor inserts the HTML). */
  convertForInsert(id: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return firstValueFrom(this.http.post<{ html: string; filename: string }>(`/api/documents/${id}/import`, form));
  }
  getDocument(id: string) {
    return firstValueFrom(this.http.get<DocumentDetail>(`/api/documents/${id}`));
  }
  /** Renames only: content is edited live over the collaboration socket. */
  updateDocument(id: string, changes: { title: string }) {
    return firstValueFrom(this.http.patch<DocumentDetail>(`/api/documents/${id}`, changes));
  }
  /** Markdown export as a file download (blob + headers for the filename). */
  exportMarkdown(id: string) {
    return firstValueFrom(
      this.http.get(`/api/documents/${id}/export`, { params: { format: 'md' }, responseType: 'blob', observe: 'response' }),
    );
  }
  deleteDocument(id: string) {
    return firstValueFrom(this.http.delete<void>(`/api/documents/${id}`));
  }

  listAttachments(id: string) {
    return firstValueFrom(this.http.get<Attachment[]>(`/api/documents/${id}/attachments`));
  }
  uploadAttachment(id: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return firstValueFrom(this.http.post<Attachment>(`/api/documents/${id}/attachments`, form));
  }
  deleteAttachment(id: string, attachmentId: string) {
    return firstValueFrom(this.http.delete<void>(`/api/documents/${id}/attachments/${attachmentId}`));
  }
  /** Direct download link (same origin, so the session cookie is sent). */
  attachmentUrl(id: string, attachmentId: string) {
    return `/api/documents/${id}/attachments/${attachmentId}`;
  }

  listShares(id: string) {
    return firstValueFrom(this.http.get<Share[]>(`/api/documents/${id}/shares`));
  }
  share(id: string, email: string, role: ShareRole) {
    return firstValueFrom(this.http.post<Share>(`/api/documents/${id}/shares`, { email, role }));
  }
  unshare(id: string, userId: string) {
    return firstValueFrom(this.http.delete<void>(`/api/documents/${id}/shares/${userId}`));
  }
}
