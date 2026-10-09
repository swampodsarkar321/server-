import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireSuperAdmin, type AuthedRequest } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../services/crypto.js';
import { getPlan, PLANS, monthKey } from '../services/plans.js';

const router = Router();
router.use(requireAuth, requireSuperAdmin);

function maskKey(enc?: string): string | null {
  if (!enc) return null;
  try {
    const raw = decryptSecret(enc);
    return `••••${raw.slice(-4)}`;
  } catch {
    return '••••(unreadable)';
  }
}

router.get('/admin/me', (req: AuthedRequest, res) => {
  res.json({ isAdmin: true, uid: req.uid });
});

router.get('/admin/overview', async (_req, res) => {
  const [wss, pages, convs, orders, claims] = await Promise.all([
    dbGet('workspaces'),
    dbGet('facebookPages'),
    dbGet('conversations'),
    dbGet('orders'),
    dbGet('billingClaims'),
  ]);
  const wsIds = Object.keys(wss ?? {});
  let convCount = 0;
  let suspended = 0;
  for (const [id, w] of Object.entries<any>(wss ?? {})) {
    if ((w as any)?.suspended) suspended++;
    void id;
  }
  for (const per of Object.values<any>(convs ?? {})) convCount += Object.keys(per ?? {}).length;
  let orderCount = 0;
  for (const per of Object.values<any>(orders ?? {})) orderCount += Object.keys(per ?? {}).length;
  let pendingClaims = 0;
  for (const per of Object.values<any>(claims ?? {})) {
    for (const c of Object.values<any>(per ?? {})) if (c.status === 'pending') pendingClaims++;
  }
  // This month's AI usage across all workspaces
  let aiMonth = 0;
  const usage = (await dbGet('usage')) ?? {};
  for (const per of Object.values<any>(usage)) {
    const m = per?.[monthKey()];
    if (m?.aiReplies) aiMonth += m.aiReplies;
  }
  res.json({
    workspaces: wsIds.length,
    suspended,
    connectedPages: Object.keys(pages ?? {}).length,
    conversations: convCount,
    orders: orderCount,
    pendingClaims,
    aiRepliesThisMonth: aiMonth,
    month: monthKey(),
  });
});

router.get('/admin/workspaces', async (_req, res) => {
  const wss = (await dbGet('workspaces')) ?? {};
  const [convs, orders, usage, members, users] = await Promise.all([
    dbGet('conversations'),
    dbGet('orders'),
    dbGet('usage'),
    dbGet('workspaceMembers'),
    dbGet('users'),
  ]);
  const list = await Promise.all(
    Object.entries<any>(wss).map(async ([id, w]) => {
      const bot = await dbGet(`botSettings/${id}`);
      const pages = await dbGet(`facebookPagesByWorkspace/${id}`);
      const ownerUid: string | null = w.createdBy ?? Object.keys(members?.[id] ?? {})[0] ?? null;
      const owner = ownerUid ? (users?.[ownerUid] ?? null) : null;
      let ownerEmail: string | null = owner?.email ?? null;
      if (ownerUid && !ownerEmail) {
        try {
          const { getAuth } = await import('firebase-admin/auth');
          ownerEmail = (await getAuth().getUser(ownerUid)).email ?? null;
        } catch {
          ownerEmail = null;
        }
      }
      return {
        id,
        name: w.name,
        businessName: w.businessName,
        planId: w.planId ?? 'free',
        suspended: Boolean(w.suspended),
        createdAt: w.createdAt,
        ownerUid,
        ownerName: owner?.displayName ?? null,
        ownerEmail,
        ownerApproved: owner?.approved !== false,
        conversations: Object.keys(convs?.[id] ?? {}).length,
        orders: Object.keys(orders?.[id] ?? {}).length,
        pages: Object.keys(pages ?? {}),
        members: Object.keys(members?.[id] ?? {}).length,
        aiThisMonth: usage?.[id]?.[monthKey()]?.aiReplies ?? 0,
        plan: getPlan(w.planId).name,
        hasCustomKey: Boolean(bot?.aiApiKeyEnc),
        customKeyMask: maskKey(bot?.aiApiKeyEnc),
        customModel: bot?.aiModel ?? null,
      };
    }),
  );
  list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ workspaces: list, plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, limits: p.limits })) });
});

/** All registered users (for approval queue). Shows the name given at signup. */
router.get('/admin/users', async (req: AuthedRequest, res) => {
  const status = (req.query.status as string) ?? 'all';
  const users = (await dbGet('users')) ?? {};
  const out: any[] = [];
  for (const [uid, u] of Object.entries<any>(users)) {
    const approved = u?.approved !== false;
    if (status === 'pending' && approved) continue;
    if (status === 'approved' && !approved) continue;
    let email: string | null = u?.email ?? null;
    if (!email) {
      try {
        const { getAuth } = await import('firebase-admin/auth');
        email = (await getAuth().getUser(uid)).email ?? null;
      } catch {
        email = null;
      }
    }
    out.push({
      uid,
      displayName: u?.displayName ?? null,
      email,
      approved,
      createdAt: u?.createdAt ?? null,
      approvedBy: u?.approvedBy ?? null,
      approvedAt: u?.approvedAt ?? null,
    });
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ users: out.slice(0, 300) });
});

const approvalSchema = z.object({ approved: z.boolean() });

router.patch('/admin/users/:uid/approval', async (req: AuthedRequest, res) => {
  const parsed = approvalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'approved boolean required' } });
    return;
  }
  const existing = await dbGet(`users/${req.params.uid}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    return;
  }
  await dbUpdate(`users/${req.params.uid}`, {
    approved: parsed.data.approved,
    approvedBy: req.uid,
    approvedAt: Date.now(),
  });
  await dbPushLog(req.params.uid, req.uid!, parsed.data.approved ? 'user approved' : 'user approval revoked');
  res.json({ uid: req.params.uid, approved: parsed.data.approved });
});

const planSchema = z.object({ planId: z.enum(['free', 'starter', 'business']) });

router.patch('/admin/workspaces/:wsId/plan', async (req: AuthedRequest, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'planId must be free|starter|business' } });
    return;
  }
  const existing = await dbGet(`workspaces/${req.params.wsId}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    return;
  }
  await dbUpdate(`workspaces/${req.params.wsId}`, { planId: parsed.data.planId });
  await dbPushLog(req.params.wsId, req.uid!, `plan → ${parsed.data.planId}`);
  res.json({ id: req.params.wsId, planId: parsed.data.planId });
});

const suspendSchema = z.object({ suspended: z.boolean() });

router.patch('/admin/workspaces/:wsId/suspend', async (req: AuthedRequest, res) => {
  const parsed = suspendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'suspended boolean required' } });
    return;
  }
  const existing = await dbGet(`workspaces/${req.params.wsId}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    return;
  }
  await dbUpdate(`workspaces/${req.params.wsId}`, { suspended: parsed.data.suspended });
  await dbPushLog(req.params.wsId, req.uid!, parsed.data.suspended ? 'suspended' : 'unsuspended');
  res.json({ id: req.params.wsId, suspended: parsed.data.suspended });
});

const keySchema = z.object({
  apiKey: z.string().min(10).max(300),
  model: z.string().max(80).optional(),
});

router.post('/admin/workspaces/:wsId/key', async (req: AuthedRequest, res) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Valid apiKey required' } });
    return;
  }
  const existing = await dbGet(`workspaces/${req.params.wsId}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    return;
  }
  const current = (await dbGet(`botSettings/${req.params.wsId}`)) ?? {};
  await dbSet(`botSettings/${req.params.wsId}`, {
    ...current,
    aiApiKeyEnc: encryptSecret(parsed.data.apiKey),
    ...(parsed.data.model ? { aiModel: parsed.data.model } : {}),
    updatedAt: Date.now(),
  });
  await dbPushLog(req.params.wsId, req.uid!, 'custom AI key set');
  res.json({ id: req.params.wsId, hasCustomKey: true });
});

router.delete('/admin/workspaces/:wsId/key', async (req: AuthedRequest, res) => {
  const current = (await dbGet(`botSettings/${req.params.wsId}`)) ?? {};
  const { aiApiKeyEnc: _k, ...rest } = current;
  await dbSet(`botSettings/${req.params.wsId}`, { ...rest, updatedAt: Date.now() });
  await dbPushLog(req.params.wsId, req.uid!, 'custom AI key removed');
  res.json({ id: req.params.wsId, hasCustomKey: false });
});

router.get('/admin/claims', async (req: AuthedRequest, res) => {
  const status = (req.query.status as string) ?? 'pending';
  const all = (await dbGet('billingClaims')) ?? {};
  const out: any[] = [];
  for (const [wsId, per] of Object.entries<any>(all)) {
    const ws = await dbGet(`workspaces/${wsId}`);
    for (const [key, c] of Object.entries<any>(per ?? {})) {
      if (status !== 'all' && c.status !== status) continue;
      out.push({ workspaceId: wsId, workspaceName: ws?.name ?? ws?.businessName ?? wsId, key, ...c });
    }
  }
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ claims: out.slice(0, 200) });
});

const claimVerify = z.object({ workspaceId: z.string().min(1), status: z.enum(['verified', 'rejected']) });

router.patch('/admin/claims/:claimKey/verify', async (req: AuthedRequest, res) => {
  const parsed = claimVerify.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'workspaceId + verified|rejected required' } });
    return;
  }
  const existing = await dbGet(`billingClaims/${parsed.data.workspaceId}/${req.params.claimKey}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Claim not found' } });
    return;
  }
  await dbUpdate(`billingClaims/${parsed.data.workspaceId}/${req.params.claimKey}`, {
    status: parsed.data.status,
    verifiedBy: req.uid,
    verifiedAt: Date.now(),
  });
  // Auto-activate plan from the purchased package on verify
  if (parsed.data.status === 'verified') {
    const planMap: Record<string, string> = { trial: 'free', business: 'starter', premium: 'business' };
    const planId = planMap[existing.package] ?? 'starter';
    await dbUpdate(`workspaces/${parsed.data.workspaceId}`, { planId, suspended: false });
  }
  res.json({ status: parsed.data.status });
});

async function dbPushLog(wsId: string, uid: string, action: string): Promise<void> {
  const { dbPush } = await import('../services/firebase.js');
  await dbPush(`adminAudit/${wsId}`, { action, by: uid, at: Date.now() });
}

export default router;
