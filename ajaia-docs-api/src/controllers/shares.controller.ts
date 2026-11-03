import type { Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import type { ShareModel } from '../models/share.model.js';
import type { UserModel } from '../models/user.model.js';
import type { AccessService } from '../services/access.service.js';
import type { CollabService } from '../services/collab.service.js';
import { shareBody } from '../validators/document.validator.js';
import { shareView } from '../views/share.view.js';

interface Deps {
  shares: ShareModel;
  users: UserModel;
  access: AccessService;
  collab: CollabService;
}

/** Anyone with access can see who else has access; only the owner can change it. */
export function createSharesController({ shares, users, access, collab }: Deps) {
  return {
    list(req: Request, res: Response) {
      const { doc } = access.requireAccess(String(req.params.id), req.user!.id);
      res.json(shares.listForDocument(doc.id).map(shareView));
    },

    /** Grants access, or changes an existing user's role. Applies to their open sessions immediately. */
    grant(req: Request, res: Response) {
      const { email, role } = shareBody.parse(req.body);
      const doc = access.requireOwner(String(req.params.id), req.user!.id);
      const target = users.findByEmail(email);
      if (!target) throw new HttpError(404, `No user with email ${email}`);
      if (target.id === doc.ownerId) throw new HttpError(400, 'The owner already has full access');

      shares.upsert(doc.id, target.id, role);
      collab.accessChanged(doc.id, target.id, role);
      res.status(201).json(shareView({ userId: target.id, email: target.email, name: target.name, role }));
    },

    revoke(req: Request, res: Response) {
      const doc = access.requireOwner(String(req.params.id), req.user!.id);
      const userId = String(req.params.userId);
      shares.remove(doc.id, userId);
      collab.accessChanged(doc.id, userId, null);
      res.status(204).end();
    },
  };
}

export type SharesController = ReturnType<typeof createSharesController>;
