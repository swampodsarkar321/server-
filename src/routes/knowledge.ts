import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireWorkspace, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { getPlan, monthKey } from '../services/plans.js';

const router = Router();

const upsertSchema = z.object({
  workspaceId: z.string().min(1),
  type: z.enum(['faq', 'product', 'policy', 'hours', 'contact', 'general']),
  title: z.string().max(160).optional(),
  question: z.string().max(500).optional(),
  answer: z.string().min(1).max(4000),
  enabled: z.boolean().optional(),
});

const patchSchema = upsertSchema.partial().omit({ workspaceId: true });

async function enforceKnowledgeLimit(workspaceId: string): Promise<{ allowed: boolean; plan: string; count: number; limit: number }> {
  const ws = (await dbGet(`workspaces/${workspaceId}`)) ?? { planId: 'free' };
  const plan = getPlan(ws.planId);
  const kb = (await dbGet(`knowledgeBase/${workspaceId}`)) ?? {};
  const count = Object.keys(kb).length;
  return { allowed: count < plan.limits.knowledgeEntries, plan: plan.id, count, limit: plan.limits.knowledgeEntries };
}

router.get('/knowledge', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const kb = (await dbGet(`knowledgeBase/${req.workspaceId}`)) ?? {};
  const entries = Object.entries<any>(kb).map(([id, v]) => ({ id, ...v }));
  entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  res.json({ entries });
});

router.post('/knowledge', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid knowledge entry', details: parsed.error.flatten() } });
    return;
  }
  const gate = await enforceKnowledgeLimit(req.workspaceId!);
  if (!gate.allowed) {
    res.status(402).json({ error: { code: 'PLAN_LIMIT', message: `Knowledge limit reached (${gate.count}/${gate.limit} on ${gate.plan} plan)`, usage: gate } });
    return;
  }
  const id = `kb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const entry = { ...parsed.data, workspaceId: req.workspaceId, enabled: parsed.data.enabled ?? true, updatedAt: Date.now() };
  await dbSet(`knowledgeBase/${req.workspaceId}/${id}`, entry);
  res.status(201).json({ entry: { id, ...entry } });
});

router.patch('/knowledge/:entryId', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid patch', details: parsed.error.flatten() } });
    return;
  }
  const existing = await dbGet(`knowledgeBase/${req.workspaceId}/${req.params.entryId}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
    return;
  }
  await dbUpdate(`knowledgeBase/${req.workspaceId}/${req.params.entryId}`, { ...parsed.data, updatedAt: Date.now() });
  res.json({ entry: { id: req.params.entryId, ...existing, ...parsed.data } });
});

router.delete('/knowledge/:entryId', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const existing = await dbGet(`knowledgeBase/${req.workspaceId}/${req.params.entryId}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
    return;
  }
  await dbSet(`knowledgeBase/${req.workspaceId}/${req.params.entryId}`, null);
  res.json({ deleted: req.params.entryId });
});

const importSchema = z.object({
  workspaceId: z.string().min(1),
  entries: z
    .array(
      z.object({
        type: z.enum(['faq', 'product', 'policy', 'hours', 'contact', 'general']).default('general'),
        title: z.string().max(160).optional(),
        question: z.string().max(500).optional(),
        answer: z.string().min(1).max(4000),
        enabled: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
});

router.post('/knowledge/import', requireAuth, requireWorkspace, requireRole('owner', 'admin'), async (req: AuthedRequest, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid import payload (expected { entries: [...] }, max 200)', details: parsed.error.flatten() } });
    return;
  }
  const ws = (await dbGet(`workspaces/${req.workspaceId}`)) ?? { planId: 'free' };
  const plan = getPlan(ws.planId);
  const kb = (await dbGet(`knowledgeBase/${req.workspaceId}`)) ?? {};
  const room = plan.limits.knowledgeEntries - Object.keys(kb).length;
  if (parsed.data.entries.length > room) {
    res.status(402).json({ error: { code: 'PLAN_LIMIT', message: `Import of ${parsed.data.entries.length} exceeds remaining quota (${room} left on ${plan.id})` } });
    return;
  }
  const created: any[] = [];
  for (const e of parsed.data.entries) {
    const id = `kb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    await dbSet(`knowledgeBase/${req.workspaceId}/${id}`, { ...e, enabled: e.enabled ?? true, workspaceId: req.workspaceId, updatedAt: Date.now() });
    created.push(id);
    await new Promise((r) => setTimeout(r, 1));
  }
  res.status(201).json({ imported: created.length, ids: created, month: monthKey() });
});

export default router;
