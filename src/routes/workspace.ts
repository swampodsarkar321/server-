import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbPush } from '../services/firebase.js';
import { requireAuth, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const profile = await dbGet(`users/${req.uid}`);
  const memberships = await dbGet(`workspaceMembers`);
  const workspaceIds: string[] = [];
  if (memberships && typeof memberships === 'object') {
    for (const [ws, members] of Object.entries<any>(memberships)) {
      if (members && members[req.uid!]) workspaceIds.push(ws);
    }
  }
  res.json({ uid: req.uid, profile: profile ?? null, workspaceIds });
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

router.post('/workspaces', requireAuth, async (req: AuthedRequest, res) => {
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

export default router;
