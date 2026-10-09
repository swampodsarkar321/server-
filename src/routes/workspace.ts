import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbPush, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireApproved, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';
import { isSuperAdmin, isSuperAdminEmail } from '../config/env.js';

const router = Router();

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  let profile = await dbGet(`users/${req.uid}`);
  const memberships = await dbGet(`workspaceMembers`);
  const workspaceIds: string[] = [];
  if (memberships && typeof memberships === 'object') {
    for (const [ws, members] of Object.entries<any>(memberships)) {
      if (members && members[req.uid!]) workspaceIds.push(ws);
    }
  }
  // Auto-create missing profile. Grandfather existing active users as approved;
  // brand-new signups (no workspace yet) start as pending.
  if (!profile) {
    const admin = isSuperAdmin(req.uid) || isSuperAdminEmail(req.email);
    profile = {
      email: req.email ?? null,
      displayName: null,
      approved: admin || workspaceIds.length > 0,
      createdAt: Date.now(),
      ...(admin ? { approvedBy: 'auto-super-admin', approvedAt: Date.now() } : {}),
    };
    await dbSet(`users/${req.uid}`, profile);
  }
  res.json({
    uid: req.uid,
    profile: profile ?? null,
    workspaceIds,
    isAdmin: isSuperAdmin(req.uid) || isSuperAdminEmail(req.email),
    approved: profile?.approved !== false,
  });
});

const profileSchema = z.object({
  displayName: z.string().min(2).max(60),
});

router.post('/me/profile', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Display name (2-60 chars) is required' } });
    return;
  }
  const existing = (await dbGet(`users/${req.uid}`)) ?? {};
  const admin = isSuperAdmin(req.uid) || isSuperAdminEmail(req.email);
  const isNew = !existing.createdAt;
  await dbUpdate(`users/${req.uid}`, {
    displayName: parsed.data.displayName,
    email: req.email ?? existing.email ?? null,
    ...(isNew ? { createdAt: Date.now(), approved: admin } : {}),
  });
  const updated = await dbGet(`users/${req.uid}`);
  res.json({ profile: updated });
});

router.get('/workspaces', requireAuth, async (req: AuthedRequest, res) => {
  const memberships = await dbGet(`workspaceMembers`);
  const out: any[] = [];
  if (memberships && typeof memberships === 'object') {
    for (const [ws, members] of Object.entries<any>(memberships)) {
      if (members?.[req.uid!]) {
        const wsData = await dbGet(`workspaces/${ws}`);
        out.push({ id: ws, role: members[req.uid!].role, ...(wsData ?? {}) });
      }
    }
  }
  res.json({ workspaces: out });
});

const createWs = z.object({
  name: z.string().min(2).max(80),
  businessName: z.string().min(1).max(120).optional(),
});

router.post('/workspaces', requireAuth, requireApproved, async (req: AuthedRequest, res) => {
  const parsed = createWs.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid workspace payload', details: parsed.error.flatten() } });
    return;
  }
  const id = await dbPush('workspaces', {
    name: parsed.data.name,
    businessName: parsed.data.businessName ?? parsed.data.name,
    planId: 'free',
    createdBy: req.uid,
    createdAt: Date.now(),
  });
  // dbPush on RTDB returns key but our mem fallback differs; normalize:
  const wsId = typeof id === 'string' ? id : String(Date.now());
  await dbSet(`workspaceMembers/${wsId}/${req.uid}`, { role: 'owner', joinedAt: Date.now() });
  await dbSet(`botSettings/${wsId}`, {
    enabled: true,
    businessName: parsed.data.businessName ?? parsed.data.name,
    replyLanguage: 'auto',
    tone: 'friendly',
    welcomeMessage: 'Hello! Thanks for messaging us. How can I help you today?',
    fallbackMessage: "Thanks for your message. I don't have that information right now — I've notified our team and a human agent will follow up shortly.",
    handoverKeywords: ['human', 'agent', 'refund', 'complaint'],
    forbiddenTopics: [],
    maxReplyChars: 600,
    updatedAt: Date.now(),
  });
  res.status(201).json({ workspace: { id: wsId, name: parsed.data.name, planId: 'free' } });
});

router.get('/workspaces/:workspaceId', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const ws = await dbGet(`workspaces/${req.workspaceId}`);
  if (!ws) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    return;
  }
  res.json({ workspace: { id: req.workspaceId, role: req.workspaceRole, ...ws } });
});

/** Real team roster: workspace members enriched with Auth emails (server-side only). */
router.get('/team', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const members = (await dbGet(`workspaceMembers/${req.workspaceId}`)) ?? {};
  const list: Array<{ uid: string; role: string; email: string | null; joinedAt: number | null }> = [];
  for (const [uid, m] of Object.entries<any>(members)) {
    let email: string | null = null;
    try {
      const { getAuth } = await import('firebase-admin/auth');
      const u = await getAuth().getUser(uid);
      email = u.email ?? (u.phoneNumber ?? null);
    } catch {
      email = null;
    }
    list.push({ uid, role: m?.role ?? 'agent', email, joinedAt: m?.joinedAt ?? null });
  }
  list.sort((a, b) => (a.role === 'owner' ? -1 : 1));
  res.json({ members: list });
});

export default router;
