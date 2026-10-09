import { Router } from 'express';
import { z } from 'zod';
import { dbGet, dbSet, dbUpdate } from '../services/firebase.js';
import { requireAuth, requireWorkspace, type AuthedRequest } from '../middleware/auth.js';
import { DEFAULT_BOT_SETTINGS, buildSystemPrompt, searchKnowledge, type KnowledgeEntry } from '../services/knowledge.js';
import { generateReply, resolveWorkspaceKey, type ChatMessage } from '../services/ai.js';

const router = Router();

const settingsSchema = z.object({
  workspaceId: z.string().min(1),
  enabled: z.boolean().optional(),
  businessName: z.string().min(1).max(120).optional(),
  businessDescription: z.string().max(2000).optional(),
  replyLanguage: z.enum(['auto', 'en', 'bn', 'banglish']).optional(),
  tone: z.enum(['friendly', 'professional', 'casual', 'concise']).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  fallbackMessage: z.string().max(1000).optional(),
  businessHours: z.string().max(500).optional(),
  handoverKeywords: z.array(z.string().max(60)).max(50).optional(),
  forbiddenTopics: z.array(z.string().max(80)).max(50).optional(),
  maxReplyChars: z.number().int().min(50).max(2000).optional(),
  aiProvider: z.string().max(40).optional(),
  aiModel: z.string().max(80).optional(),
  orderFlowEnabled: z.boolean().optional(),
  commentReplyEnabled: z.boolean().optional(),
  commentReplyTemplate: z.string().max(800).optional(),
});

function maskSettings(s: any): any {
  const { aiApiKeyEnc: _k, ...rest } = s ?? {};
  return { ...rest, hasCustomKey: Boolean(s?.aiApiKeyEnc) };
}

router.get('/bot/settings', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const s = (await dbGet(`botSettings/${req.workspaceId}`)) ?? DEFAULT_BOT_SETTINGS;
  res.json({ settings: maskSettings({ ...DEFAULT_BOT_SETTINGS, ...s }) });
});

router.patch('/bot/settings', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid settings', details: parsed.error.flatten() } });
    return;
  }
  const { workspaceId: _w, aiApiKey: _ignored, ...patch } = parsed.data as any;
  const current = (await dbGet(`botSettings/${req.workspaceId}`)) ?? DEFAULT_BOT_SETTINGS;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await dbSet(`botSettings/${req.workspaceId}`, next);
  res.json({ settings: maskSettings(next) });
});

const testSchema = z.object({
  workspaceId: z.string().min(1),
  message: z.string().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(['user', 'model']), text: z.string().max(2000) })).max(20).optional(),
});

/** Test-chat panel: runs the real AI pipeline without sending Messenger messages. */
router.post('/bot/test', requireAuth, requireWorkspace, async (req: AuthedRequest, res) => {
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid test payload', details: parsed.error.flatten() } });
    return;
  }
  const settings = { ...DEFAULT_BOT_SETTINGS, ...((await dbGet(`botSettings/${req.workspaceId}`)) ?? {}) };
  const kbRaw = (await dbGet(`knowledgeBase/${req.workspaceId}`)) ?? {};
  const entries: KnowledgeEntry[] = Object.entries<any>(kbRaw).map(([id, v]) => ({ id, ...v }));
  const matched = searchKnowledge(parsed.data.message, entries, 4);
  const systemPrompt = buildSystemPrompt(settings, matched);
  const history: ChatMessage[] = (parsed.data.history ?? []).map((h) => ({ role: h.role, text: h.text }));
  const result = await generateReply({
    systemPrompt,
    userText: parsed.data.message,
    history,
    fallbackMessage: settings.fallbackMessage,
    providerName: settings.aiProvider,
    model: settings.aiModel,
    apiKeyOverride: resolveWorkspaceKey(settings),
  });
  const reply = result.ok ? result.text.slice(0, settings.maxReplyChars) : result.text;
  res.json({
    reply,
    simulated: true,
    matchedKnowledge: matched.map((m) => ({ id: m.id, title: m.title ?? m.question ?? m.type })),
    usage: { provider: result.provider, model: result.model, inputChars: result.inputChars, outputChars: result.outputChars, latencyMs: result.latencyMs },
    aiOk: result.ok,
    aiError: result.error ?? null,
  });
});

export default router;
