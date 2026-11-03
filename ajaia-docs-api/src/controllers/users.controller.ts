import type { Request, Response } from 'express';
import type { UserModel } from '../models/user.model.js';
import { userView } from '../views/user.view.js';

export function createUsersController({ users }: { users: UserModel }) {
  return {
    /** Everyone who can be shared with (the share picker). */
    list(_req: Request, res: Response) {
      res.json(users.list().map(userView));
    },
  };
}

export type UsersController = ReturnType<typeof createUsersController>;
