import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbPush, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireWorkspace, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { decryptSecret } from '../services/crypto.js';
import { sendMessengerText } from '../services/meta.js';

const router = Router();

const WINDOW_MS = 24 * 60 * 60 * 1000; // Meta standard messaging window

/** Eligible recipients: real Page conversations active within the last 24h. */
export async function eligibleRecipients(workspaceId: string): Promise<Array<{ convId: string; psid: string; pageId: string; name: string | null }>> {
  const all = (await dbGet(`conversations/${workspaceId}`)) ?? {};
  const out: Array<{ convId: string; psid: string; pageId: string; name: string | null }> = [];
  const now = Date.now();
  for (const [id, c] of Object.entries<any>(all)) {
    if (String(id).startsWith('sim_')) continue;
    if (!c?.psid || !c?.pageId) continue;
    if (!c.lastMessageAt || now - c.lastMessageAt > WINDOW_MS) continue;
    out.push({ convId: id, psid: c.psid, pageId: c.pageId, name: c.customerName ?? null });
  }
  return out;
}

router.get('/broadcast/eligible', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const list = await eligibleRecipients(req.workspaceId!);
  res.json({ count: list.length, windowHours: 24, recipients: list.map((r) => ({ convId: r.convId, name: r.name })) });
});

const castSchema = z.object({
  workspaceId: z.string().min(1),
  text: z.string().min(1).max(1000),
  dryRun: z.boolean().optional(),
});

router.post('/broadcast', requireAuth, requireWorkspace, requireRole('owner', 'admin'), async (req: AuthedRequest, res) => {
  const parsed = castSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Broadcast text (1-1000 chars) required', details: parsed.error.flatten() } });
    return;
  }
  const list = await eligibleRecipients(req.workspaceId!);
  if (parsed.data.dryRun) {
    res.json({ dryRun: true, wouldSend: list.length });
    return;
  }
  let sent = 0;
  const failed: Array<{ convId: string; error: string }> = [];
  for (const r of list.slice(0, 200)) {
    try {
      const page = await dbGet(`facebookPages/${r.pageId}`);
      if (!page?.encryptedToken) throw new Error('Page token missing');
      await sendMessengerText(decryptSecret(page.encryptedToken), r.psid, parsed.data.text);
      await dbPush(`messages/${req.workspaceId}/${r.convId}`, {
        sender: 'bot',
        text: parsed.data.text,
        createdAt: Date.now(),
        via: 'broadcast',
      });
      sent++;
      await new Promise((t) => setTimeout(t, 300)); // gentle pacing, no spam bursts
    } catch (e: any) {
      failed.push({ convId: r.convId, error: (e?.message ?? 'failed').slice(0, 150) });
    }
  }
  await dbPush(`broadcasts/${req.workspaceId}`, {
    text: parsed.data.text.slice(0, 200),
    sent,
    failed: failed.length,
    by: req.uid,
    createdAt: Date.now(),
  });
  // Honest result: never claim full success when some failed
  res.json({ sent, failed: failed.length, failures: failed.slice(0, 20), total: list.length });
});

router.get('/orders', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const status = req.query.status as string | undefined;
  const all = (await dbGet(`orders/${req.workspaceId}`)) ?? {};
  let list = Object.entries<any>(all).map(([key, v]) => ({ key, ...v }));
  if (status && status !== 'all') list = list.filter((o) => o.status === status);
  list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ orders: list.slice(0, 200) });
});

const orderStatus = z.object({ workspaceId: z.string().min(1), status: z.enum(['new', 'confirmed', 'shipped', 'delivered', 'cancelled']) });

router.patch('/orders/:orderKey/status', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = orderStatus.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid status' } });
    return;
  }
  const existing = await dbGet(`orders/${req.workspaceId}/${req.params.orderKey}`);
  if (!existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    return;
  }
  await dbUpdate(`orders/${req.workspaceId}/${req.params.orderKey}`, { status: parsed.data.status });
  res.json({ status: parsed.data.status });
});

export default router;
