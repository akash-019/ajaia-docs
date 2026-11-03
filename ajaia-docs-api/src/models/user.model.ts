import type { Db } from '../db/database.js';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface UserWithPassword extends User {
  passwordHash: string | null;
}

/** Data access for users. */
export function createUserModel(db: Db) {
  const byId = db.prepare('SELECT id, email, name FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT id, email, name FROM users WHERE email = ?');
  const byEmailWithPassword = db.prepare('SELECT id, email, name, password_hash AS passwordHash FROM users WHERE email = ?');
  const all = db.prepare('SELECT id, email, name FROM users ORDER BY name');

  return {
    findById: (id: string) => byId.get(id) as unknown as User | undefined,
    findByEmail: (email: string) => byEmail.get(email) as unknown as User | undefined,
    findByEmailWithPassword: (email: string) => byEmailWithPassword.get(email) as unknown as UserWithPassword | undefined,
    list: () => all.all() as unknown as User[],
  };
}

export type UserModel = ReturnType<typeof createUserModel>;
