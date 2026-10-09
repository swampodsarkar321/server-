import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbUpdate, dbPush } from '../services/firebase.js';
import { requireAuth, requireApproved, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';
import { decryptSecret } from '../services/crypto.js';
import { sendMessengerText } from '../services/meta.js';

const router = Router();

router.get('/notifications', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const all = (await dbGet(`notifications/${req.workspaceId}`)) ?? {};
  const list = Object.entries<any>(all).map(([id, v]) => ({ id, ...v }));
  list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  res.json({ notifications: list.slice(0, 50), unread: list.filter((n) => !n.read).length });
});

router.post('/notifications/read', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const all = (await dbGet(`notifications/${req.workspaceId}`)) ?? {};
  for (const [id, n] of Object.entries<any>(all)) {
    if (!n.read) await dbUpdate(`notifications/${req.workspaceId}/${id}`, { read: true });
  }
  res.json({ ok: true });
});

function convPath(ws: string) {
  return `conversations/${ws}`;
}

router.get('/conversations', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const status = req.query.status as string | undefined;
  const search = ((req.query.search as string) ?? '').toLowerCase();
  const all = (await dbGet(convPath(req.workspaceId!))) ?? {};
  let list = Object.entries<any>(all).map(([id, v]) => ({ id, ...v }));
  if (status && status !== 'all') list = list.filter((c) => c.status === status);
  if (search) {
    list = list.filter(
      (c) =>
        (c.customerName ?? '').toLowerCase().includes(search) ||
        (c.lastMessage ?? '').toLowerCase().includes(search) ||
        (c.psid ?? '').includes(search),
    );
  }
  list.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  res.json({ conversations: list.slice(0, 100) });
});

router.get('/conversations/:conversationId/messages', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const conv = await dbGet(`${convPath(req.workspaceId!)}/${req.params.conversationId}`);
  if (!conv) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    return;
  }
  const msgs = (await dbGet(`messages/${req.workspaceId}/${req.params.conversationId}`)) ?? {};
  const list = Object.entries<any>(msgs).map(([id, v]) => ({ id, ...v }));
  list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const handovers = (await dbGet(`handovers/${req.workspaceId}/${req.params.conversationId}`)) ?? {};
  res.json({
    conversation: { id: req.params.conversationId, ...conv },
    messages: list.slice(-200),
    handovers: Object.entries<any>(handovers).map(([id, v]) => ({ id, ...v })),
  });
});

const replySchema = z.object({
  workspaceId: z.string().min(1),
  text: z.string().min(1).max(2000),
});

router.post('/conversations/:conversationId/reply', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid reply', details: parsed.error.flatten() } });
    return;
  }
  const conv = await dbGet(`${convPath(req.workspaceId!)}/${req.params.conversationId}`);
  if (!conv) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    return;
  }
  // Human takes over: pause automation
  await dbUpdate(`${convPath(req.workspaceId!)}/${req.params.conversationId}`, {
    status: conv.status === 'resolved' ? 'resolved' : 'waiting_human',
    aiPaused: true,
    lastMessage: parsed.data.text,
    lastMessageAt: Date.now(),
    lastSender: 'agent',
  });
  const msgId = await dbPush(`messages/${req.workspaceId}/${req.params.conversationId}`, {
    sender: 'agent',
    agentUid: req.uid,
    text: parsed.data.text,
    createdAt: Date.now(),
    via: conv.pageId ? 'dashboard_to_messenger' : 'dashboard',
  });
  // If this conversation came from a real Page, forward to Messenger
  let forwarded = false;
  let forwardError: string | null = null;
  if (conv.pageId && conv.psid) {
    try {
      const page = await dbGet(`facebookPages/${conv.pageId}`);
      if (page?.encryptedToken) {
        const token = decryptSecret(page.encryptedToken);
        await sendMessengerText(token, conv.psid, parsed.data.text);
        forwarded = true;
      }
    } catch (e: any) {
      forwardError = e?.message ?? 'Forward failed';
    }
  }
  // Never claim success when forwarding failed
  res.json({ messageId: msgId, forwarded, forwardError });
});

router.post('/conversations/:conversationId/handover', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const conv = await dbGet(`${convPath(req.workspaceId!)}/${req.params.conversationId}`);
  if (!conv) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    return;
  }
  const reason = String(req.body?.reason ?? 'manual').slice(0, 120);
  await dbUpdate(`${convPath(req.workspaceId!)}/${req.params.conversationId}`, {
    status: 'waiting_human',
    aiPaused: true,
  });
  const hid = await dbPush(`handovers/${req.workspaceId}/${req.params.conversationId}`, {
    reason,
    by: req.uid,
    createdAt: Date.now(),
    type: 'manual',
  });
  res.json({ handoverId: hid, status: 'waiting_human' });
});

router.post('/conversations/:conversationId/resume', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const conv = await dbGet(`${convPath(req.workspaceId!)}/${req.params.conversationId}`);
  if (!conv) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    return;
  }
  await dbUpdate(`${convPath(req.workspaceId!)}/${req.params.conversationId}`, { status: 'open', aiPaused: false });
  await dbPush(`handovers/${req.workspaceId}/${req.params.conversationId}`, {
    reason: 'automation_resumed',
    by: req.uid,
    createdAt: Date.now(),
    type: 'resume',
  });
  res.json({ status: 'open' });
});

const statusSchema = z.object({ workspaceId: z.string().min(1), status: z.enum(['open', 'resolved', 'waiting_human']) });

router.patch('/conversations/:conversationId/status', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid status', details: parsed.error.flatten() } });
    return;
  }
  const conv = await dbGet(`${convPath(req.workspaceId!)}/${req.params.conversationId}`);
  if (!conv) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    return;
  }
  await dbUpdate(`${convPath(req.workspaceId!)}/${req.params.conversationId}`, { status: parsed.data.status });
  res.json({ status: parsed.data.status });
});

router.post('/conversations/:conversationId/notes', requireAuth, requireApproved, requireWorkspace, async (req: AuthedRequest, res) => {
  const text = String(req.body?.text ?? '').slice(0, 1000);
  if (!text) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Note text required' } });
    return;
  }
  const id = await dbPush(`messages/${req.workspaceId}/${req.params.conversationId}`, {
    sender: 'note',
    agentUid: req.uid,
    text,
    createdAt: Date.now(),
    internal: true,
  });
  res.status(201).json({ noteId: id });
});

export default router;
