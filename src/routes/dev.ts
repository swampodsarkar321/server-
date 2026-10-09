import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbPush } from '../services/firebase.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { DEFAULT_BOT_SETTINGS, buildSystemPrompt, searchKnowledge, shouldHandover, type KnowledgeEntry } from '../services/knowledge.js';
import { generateReply } from '../services/ai.js';

const router = Router();

const simSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  message: z.string().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(2000) })).max(20).optional(),
  psid: z.string().max(80).optional(),
});

/**
 * Development simulator — clearly labelled simulated:true, never treated as
 * real Facebook activity. Runs the REAL AI backend + knowledge retrieval +
 * handover detection so owners can test before Meta approval.
 */
router.post('/dev/simulate', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = simSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid simulator payload', details: parsed.error.flatten() } });
    return;
  }
  // Resolve workspace: explicit (membership-checked) or first owned workspace
  let ws: string | null = null;
  if (parsed.data.workspaceId) {
    const m = await dbGet(`workspaceMembers/${parsed.data.workspaceId}/${req.uid}`);
    if (!m) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not a member of this workspace' } });
      return;
    }
    ws = parsed.data.workspaceId;
  } else {
    const all = (await dbGet('workspaceMembers')) ?? {};
    for (const [id, members] of Object.entries<any>(all)) {
      if (members?.[req.uid!]) {
        ws = id;
        break;
      }
    }
  }
  if (!ws) {
    res.status(400).json({ error: { code: 'NO_WORKSPACE', message: 'Create a workspace first (POST /api/workspaces)' } });
    return;
  }

  const settings = { ...DEFAULT_BOT_SETTINGS, ...((await dbGet(`botSettings/${ws}`)) ?? {}) };
  const kbRaw = (await dbGet(`knowledgeBase/${ws}`)) ?? {};
  const entries: KnowledgeEntry[] = Object.entries<any>(kbRaw).map(([id, v]) => ({ id, ...v }));
  const matched = searchKnowledge(parsed.data.message, entries, 4);
  const handover = shouldHandover(parsed.data.message, settings, 0);

  let reply: string;
  let aiMeta: any;
  if (!settings.enabled) {
    reply = '(Bot is disabled — no reply would be sent.)';
    aiMeta = { skipped: 'bot_disabled' };
  } else if (handover.handover) {
    reply = 'Thanks — I’ve flagged this for our team and a human agent will take over shortly.';
    aiMeta = { handover: handover.reason };
  } else {
    const result = await generateReply({
      systemPrompt: buildSystemPrompt(settings, matched),
      userText: parsed.data.message,
      history: (parsed.data.history ?? []).map((h) => ({ role: h.role, text: h.text })),
      fallbackMessage: settings.fallbackMessage,
      providerName: settings.aiProvider,
      model: settings.aiModel,
    });
    reply = result.ok ? result.text.slice(0, settings.maxReplyChars) : result.text;
    aiMeta = { provider: result.provider, model: result.model, ok: result.ok, error: result.error ?? null, latencyMs: result.latencyMs };
  }

  // Persist to a simulated conversation thread for inspection
  const psid = parsed.data.psid ?? 'sim_user';
  const convId = `sim_${psid}`;
  await dbPush(`messages/${ws}/${convId}`, { sender: 'customer', text: parsed.data.message, createdAt: Date.now(), simulated: true });
  await dbPush(`messages/${ws}/${convId}`, { sender: 'bot', text: reply, createdAt: Date.now(), simulated: true });
  await dbSet(`conversations/${ws}/${convId}`, {
    simulated: true,
    psid,
    status: handover.handover ? 'waiting_human' : 'open',
    lastMessage: reply,
    lastMessageAt: Date.now(),
    lastSender: 'bot',
  });

  res.json({
    simulated: true,
    workspaceId: ws,
    reply,
    handover: handover.handover ? handover.reason : null,
    matchedKnowledge: matched.map((m) => ({ id: m.id, title: m.title ?? m.question ?? m.type })),
    ai: aiMeta,
  });
});

router.get('/dev/status', async (_req, res) => {
  const { config, hasFirebase, hasMeta } = await import('../config/env.js');
  res.json({
    simulated: true,
    firebase: hasFirebase(),
    meta: hasMeta(),
    aiProvider: config.ai.provider,
    aiModel: config.ai.model,
    geminiKeySet: Boolean(config.ai.geminiKey),
    note: 'Real Messenger messaging requires Meta App credentials + verified Page subscription. See docs/META_SETUP.md.',
  });
});

export default router;
