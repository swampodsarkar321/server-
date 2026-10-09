import type { Request, Response, NextFunction } from 'express';
import { verifyIdToken, dbGet } from '../services/firebase.js';
import { config, isSuperAdmin, isSuperAdminEmail } from '../config/env.js';

export interface AuthedRequest extends Request {
  uid?: string;
  email?: string | null;
  workspaceId?: string;
  workspaceRole?: string;
}

function getBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Verify Firebase ID token. Attaches req.uid. Allows dev bypass only with explicit allowlist. */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = getBearer(req);
  if (!token) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Missing Bearer token' } });
    return;
  }
  // Dev simulator bypass: unsigned token "dev:<uid>" only when allowlisted
  if (token.startsWith('dev:')) {
    const uid = token.slice(4);
    if (config.nodeEnv !== 'production' && config.devAllowlist.includes(uid)) {
      req.uid = uid;
      next();
      return;
    }
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Dev token not allowlisted' } });
    return;
  }
  try {
    const decoded = await verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = (decoded.email as string | undefined)?.toLowerCase() ?? null;
    next();
  } catch {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } });
  }
}

function workspaceIdFrom(req: AuthedRequest): string | null {
  return (req.query.workspaceId as string) || (req.body?.workspaceId as string) || (req.params.workspaceId as string) || null;
}

/**
 * Validate workspace membership on the server for every protected request.
 * Never trusts a browser-supplied workspaceId without a membership check.
 */
export async function requireWorkspace(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const ws = workspaceIdFrom(req);
  if (!ws || typeof ws !== 'string') {
    res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' } });
    return;
  }
  try {
    const member = await dbGet(`workspaceMembers/${ws}/${req.uid}`);
    if (!member) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' } });
      return;
    }
    req.workspaceId = ws;
    req.workspaceRole = member.role ?? 'agent';
    // Suspended workspaces are blocked everywhere (except super-admin inspection)
    const wsData = await dbGet(`workspaces/${ws}`);
    if (wsData?.suspended && !isSuperAdmin(req.uid) && !isSuperAdminEmail(req.email)) {
      res.status(403).json({ error: { code: 'WORKSPACE_SUSPENDED', message: 'Workspace suspended. Contact support.' } });
      return;
    }
    next();
  } catch (e) {
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Membership check failed' } });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.workspaceRole || !roles.includes(req.workspaceRole)) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient role' } });
      return;
    }
    next();
  };
}

/** Super-admin gate: UID in SUPER_ADMIN_UIDS or email in SUPER_ADMIN_EMAILS. Nothing else grants access. */
export function requireSuperAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!isSuperAdmin(req.uid) && !isSuperAdminEmail(req.email)) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super-admin only' } });
    return;
  }
  next();
}
