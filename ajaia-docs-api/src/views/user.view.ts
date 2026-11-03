import type { User } from '../models/user.model.js';
import type { Session } from '../services/session.service.js';

/** Public fields of a user (never the password hash). */
export function userView(user: User) {
  return { id: user.id, email: user.email, name: user.name };
}

/** The signed-in user plus when the session expires (Unix seconds). */
export function sessionUserView(user: User, session: Session) {
  return { ...userView(user), expiresAt: session.expiresAt };
}
